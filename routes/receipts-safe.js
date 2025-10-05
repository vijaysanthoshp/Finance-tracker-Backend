// Receipt OCR Processing Routes - Safe Mode
const express = require('express');
const multer = require('multer');
const AzureOCRService = require('../services/ocrService');
const { body, validationResult } = require('express-validator');
const { safeQuery, isDatabaseConnected } = require('../config/database-safe');

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
 * Upload and process receipt image with REAL Azure OCR
 */
router.post('/upload', upload.single('receipt'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No receipt image provided'
            });
        }

        const userId = req.user ? req.user.userId : 1; // Fallback user ID
        const file = req.file;

        console.log(`📤 Processing REAL receipt upload for user ${userId}`);
        console.log(`📁 File: ${file.originalname}, Size: ${file.size} bytes`);
        console.log(`🤖 Using Azure Computer Vision OCR...`);

        try {
            // Upload image to Azure Blob Storage (REAL)
            console.log('⬆️  Uploading to Azure Blob Storage...');
            const uploadResult = await ocrService.uploadReceiptImage(
                file.buffer, 
                file.originalname, 
                userId
            );
            console.log(`✅ Image uploaded: ${uploadResult.fileName}`);

            // Process receipt with Azure OCR (REAL)
            console.log('🔍 Processing with Azure Computer Vision...');
            const ocrResult = await ocrService.processReceipt(file.buffer);
            console.log(`✅ OCR completed with ${(ocrResult.confidence * 100).toFixed(1)}% confidence`);

            // Store receipt record in database (or mock if DB unavailable)
            let receiptRecord;
            if (isDatabaseConnected()) {
                console.log('💾 Storing receipt in database...');
                receiptRecord = await storeReceiptRecord(userId, uploadResult, ocrResult);
            } else {
                console.log('⚠️  Database unavailable - using mock receipt ID');
                receiptRecord = {
                    receipt_id: `mock-${Date.now()}`,
                    created_at: new Date().toISOString()
                };
            }

            res.json({
                success: true,
                message: 'Receipt processed successfully with Azure OCR',
                data: {
                    receiptId: receiptRecord.receipt_id,
                    merchantName: ocrResult.merchantName,
                    amount: ocrResult.total,
                    date: ocrResult.transactionDate,
                    suggestedCategory: ocrResult.suggestedCategory,
                    items: ocrResult.items,
                    confidence: ocrResult.confidence,
                    imageUrl: uploadResult.url,
                    databaseStored: isDatabaseConnected()
                }
            });

        } catch (ocrError) {
            console.error('❌ OCR processing error:', ocrError);
            res.status(500).json({
                success: false,
                message: 'OCR processing failed',
                error: ocrError.message,
                details: 'Check Azure Computer Vision service configuration'
            });
        }

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

            const userId = req.user ? req.user.userId : 1;
            const receiptId = req.params.receiptId;
            const { accountId, categoryId, amount, description, transactionDate } = req.body;

            console.log(`💰 Creating transaction from receipt ${receiptId}`);

            if (!isDatabaseConnected()) {
                console.log('⚠️  Database unavailable - returning mock transaction');
                return res.json({
                    success: true,
                    message: 'Transaction created successfully (MOCK - database unavailable)',
                    data: {
                        transactionId: `mock-transaction-${Date.now()}`,
                        amount: -Math.abs(amount),
                        description: description,
                        transactionDate: transactionDate,
                        receiptId: receiptId,
                        note: 'This is mock data - database connection required for real transactions'
                    }
                });
            }

            // Real database transaction creation
            try {
                // Verify receipt belongs to user
                const receiptCheck = await safeQuery(
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
                const result = await safeQuery(`
                    INSERT INTO transactions (
                        user_id, account_id, category_id, amount, description, 
                        transaction_date, transaction_type, receipt_id
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    RETURNING transaction_id, amount, description, transaction_date
                `, [userId, accountId, categoryId, -Math.abs(amount), description, transactionDate, 'EXPENSE', receiptId]);

                // Update receipt status
                await safeQuery(
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

            } catch (dbError) {
                console.error('❌ Database error creating transaction:', dbError);
                res.status(500).json({
                    success: false,
                    message: 'Database error creating transaction'
                });
            }

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
 * Store receipt record in database
 */
async function storeReceiptRecord(userId, uploadResult, ocrResult) {
    try {
        const result = await safeQuery(`
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
    } catch (error) {
        console.error('Error storing receipt record:', error);
        throw error;
    }
}

module.exports = router;