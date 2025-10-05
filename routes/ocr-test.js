const express = require('express');
const multer = require('multer');
const AzureOCRService = require('../services/ocrService');

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
 * POST /api/v1/ocr-test/upload
 * Test OCR upload without database dependency
 */
router.post('/upload', upload.single('receipt'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No receipt image provided'
            });
        }

        const file = req.file;
        console.log(`📤 Processing OCR test upload`);
        console.log(`📁 File: ${file.originalname}, Size: ${file.size} bytes, Type: ${file.mimetype}`);

        // Process receipt with OCR only (no Azure Blob Storage upload)
        console.log('🔍 Starting OCR processing...');
        const ocrResult = await ocrService.processReceipt(file.buffer);
        console.log('✅ OCR processing completed');

        // Return OCR results without database storage
        res.json({
            success: true,
            message: 'Receipt processed successfully (TEST MODE - No database storage)',
            data: {
                filename: file.originalname,
                fileSize: file.size,
                fileType: file.mimetype,
                merchantName: ocrResult.merchantName || 'Not detected',
                amount: ocrResult.total || 0,
                date: ocrResult.transactionDate || 'Not detected',
                suggestedCategory: ocrResult.suggestedCategory || 'General',
                confidence: ocrResult.confidence || 0,
                extractedText: ocrResult.rawText || 'No text extracted',
                items: ocrResult.items || [],
                ocrProcessingTime: new Date().toISOString(),
                note: 'This is a test mode - data is not saved to database'
            }
        });

    } catch (error) {
        console.error('❌ OCR test upload error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to process receipt',
            error: error.message,
            details: 'OCR service might be unavailable or image format not supported'
        });
    }
});

/**
 * GET /api/v1/ocr-test/info
 * Get OCR service information
 */
router.get('/info', (req, res) => {
    res.json({
        success: true,
        message: 'OCR Test Service Information',
        data: {
            supportedFormats: ['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/tiff', 'image/webp'],
            maxFileSize: '10MB',
            features: [
                'Text extraction from receipts',
                'Merchant name detection', 
                'Amount extraction',
                'Date recognition',
                'Item list parsing',
                'Category suggestion'
            ],
            azureServices: {
                computerVision: 'Configured',
                blobStorage: 'Available (not used in test mode)'
            },
            testMode: true,
            databaseRequired: false
        }
    });
});

module.exports = router;