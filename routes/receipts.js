// Receipt OCR Processing Routes
const express = require('express');
const multer = require('multer');
const AzureOCRService = require('../services/ocrService');
const { authenticateToken } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');
const { pool } = require('../config/database');

const router = express.Router();

// Initialize OCR service
const ocrService = new AzureOCRService();

// Configure multer for file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        // Allow only image files
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

/**
 * POST /api/v1/receipts/upload
 * Upload and process receipt image
 */
router.post('/upload', authenticateToken, upload.single('receipt'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No receipt image provided'
            });
        }

        const userId = req.user.userId;
        const file = req.file;

        console.log(`📤 Processing receipt upload for user ${userId}`);
        console.log(`📁 File: ${file.originalname}, Size: ${file.size} bytes`);

        // Upload image to Azure Blob Storage
        const uploadResult = await ocrService.uploadReceiptImage(
            file.buffer, 
            file.originalname, 
            userId
        );

        // Process receipt with OCR
        const ocrResult = await ocrService.processReceipt(file.buffer);

        // Store receipt record in database
        const receiptRecord = await storeReceiptRecord(userId, uploadResult, ocrResult);

        res.json({
            success: true,
            message: 'Receipt processed successfully',
            data: {
                receiptId: receiptRecord.receipt_id,
                merchantName: ocrResult.merchantName,
                amount: ocrResult.total,
                date: ocrResult.transactionDate,
                suggestedCategory: ocrResult.suggestedCategory,
                items: ocrResult.items,
                confidence: ocrResult.confidence,
                imageUrl: uploadResult.url
            }
        });

    } catch (error) {
        console.error('❌ Receipt upload error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to process receipt',
            error: error.message
        });
    }
});

/**
 * POST /api/v1/receipts/:receiptId/create-transaction
 * Create transaction from processed receipt
 */
router.post('/:receiptId/create-transaction', 
    authenticateToken,
    [
        body('accountId').isInt().withMessage('Account ID must be an integer'),
        body('categoryId').isInt().withMessage('Category ID must be an integer'),
        body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0'),
        body('description').trim().isLength({ min: 1 }).withMessage('Description is required'),
        body('transactionDate').isISO8601().withMessage('Valid date is required')
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({
                    success: false,
                    message: 'Validation errors',
                    errors: errors.array()
                });
            }

            const userId = req.user.userId;
            const receiptId = req.params.receiptId;
            const { accountId, categoryId, amount, description, transactionDate } = req.body;

            // Verify receipt belongs to user
            const receiptCheck = await pool.query(
                'SELECT receipt_id FROM receipts WHERE receipt_id = $1 AND user_id = $2',
                [receiptId, userId]
            );

            if (receiptCheck.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Receipt not found'
                });
            }

            // Create transaction
            const result = await pool.query(`
                INSERT INTO transactions (
                    user_id, account_id, category_id, amount, description, 
                    transaction_date, transaction_type, receipt_id
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING transaction_id, amount, description, transaction_date
            `, [userId, accountId, categoryId, -Math.abs(amount), description, transactionDate, 'EXPENSE', receiptId]);

            // Update receipt status
            await pool.query(
                'UPDATE receipts SET transaction_created = TRUE, updated_at = CURRENT_TIMESTAMP WHERE receipt_id = $1',
                [receiptId]
            );

            const transaction = result.rows[0];

            res.json({
                success: true,
                message: 'Transaction created successfully from receipt',
                data: {
                    transactionId: transaction.transaction_id,
                    amount: transaction.amount,
                    description: transaction.description,
                    transactionDate: transaction.transaction_date,
                    receiptId: receiptId
                }
            });

        } catch (error) {
            console.error('❌ Create transaction error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to create transaction',
                error: error.message
            });
        }
    }
);

/**
 * GET /api/v1/receipts
 * Get user's processed receipts
 */
router.get('/', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        const result = await pool.query(`
            SELECT 
                r.receipt_id,
                r.merchant_name,
                r.amount,
                r.transaction_date,
                r.suggested_category,
                r.confidence_score,
                r.image_url,
                r.transaction_created,
                r.created_at,
                t.transaction_id,
                t.description as transaction_description
            FROM receipts r
            LEFT JOIN transactions t ON r.receipt_id = t.receipt_id
            WHERE r.user_id = $1
            ORDER BY r.created_at DESC
            LIMIT $2 OFFSET $3
        `, [userId, limit, offset]);

        const countResult = await pool.query(
            'SELECT COUNT(*) FROM receipts WHERE user_id = $1',
            [userId]
        );

        res.json({
            success: true,
            data: {
                receipts: result.rows,
                pagination: {
                    page,
                    limit,
                    total: parseInt(countResult.rows[0].count),
                    totalPages: Math.ceil(countResult.rows[0].count / limit)
                }
            }
        });

    } catch (error) {
        console.error('❌ Get receipts error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch receipts',
            error: error.message
        });
    }
});

/**
 * DELETE /api/v1/receipts/:receiptId
 * Delete a processed receipt
 */
router.delete('/:receiptId', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const receiptId = req.params.receiptId;

        // Get receipt details
        const receiptResult = await pool.query(
            'SELECT receipt_id, image_filename FROM receipts WHERE receipt_id = $1 AND user_id = $2',
            [receiptId, userId]
        );

        if (receiptResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Receipt not found'
            });
        }

        const receipt = receiptResult.rows[0];

        // Delete from database
        await pool.query('DELETE FROM receipts WHERE receipt_id = $1', [receiptId]);

        // Delete image from Azure Storage
        if (receipt.image_filename) {
            await ocrService.deleteReceiptImage(receipt.image_filename);
        }

        res.json({
            success: true,
            message: 'Receipt deleted successfully'
        });

    } catch (error) {
        console.error('❌ Delete receipt error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete receipt',
            error: error.message
        });
    }
});

/**
 * Store receipt record in database
 */
async function storeReceiptRecord(userId, uploadResult, ocrResult) {
    const result = await pool.query(`
        INSERT INTO receipts (
            user_id, merchant_name, amount, transaction_date, 
            suggested_category, confidence_score, image_url, 
            image_filename, ocr_data, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
        RETURNING receipt_id
    `, [
        userId,
        ocrResult.merchantName,
        parseFloat(ocrResult.total),
        ocrResult.transactionDate,
        ocrResult.suggestedCategory,
        ocrResult.confidence,
        uploadResult.url,
        uploadResult.fileName,
        JSON.stringify(ocrResult)
    ]);

    return result.rows[0];
}

module.exports = router;