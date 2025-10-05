// Complete OCR with Blob Storage Route
const express = require('express');
const { BlobServiceClient } = require('@azure/storage-blob');
const multer = require('multer');
const AzureOCRService = require('../services/ocrService');

const router = express.Router();

// Configure multer for memory storage
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

/**
 * POST /upload-and-extract
 * Complete workflow: Upload image → Blob Storage → OCR → Save text → Return URLs
 */
router.post('/upload-and-extract', upload.single('receipt'), async (req, res) => {
    try {
        console.log('📤 Starting complete OCR workflow');
        
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No image file provided'
            });
        }

        console.log(`🔍 Processing: ${req.file.originalname} (${req.file.size} bytes)`);

        // Initialize services
        const ocrService = new AzureOCRService();
        const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
        const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || 'receipts';
        
        if (!connectionString) {
            throw new Error('Azure Storage connection string not configured');
        }

        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        const containerClient = blobServiceClient.getContainerClient(containerName);

        // Ensure container exists with private access
        await containerClient.createIfNotExists({
            access: 'private'
        });

        // Generate unique filenames
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileExtension = req.file.originalname.split('.').pop().toLowerCase();
        const baseFileName = req.file.originalname.replace(`.${fileExtension}`, '');
        
        const imageFileName = `images/${timestamp}-${baseFileName}.${fileExtension}`;
        const textFileName = `extracted-text/${timestamp}-${baseFileName}.json`;

        console.log('📤 Step 1: Uploading image to blob storage...');
        
        // Step 1: Upload image to blob storage
        const imageBlockBlobClient = containerClient.getBlockBlobClient(imageFileName);
        await imageBlockBlobClient.upload(req.file.buffer, req.file.buffer.length, {
            blobHTTPHeaders: {
                blobContentType: req.file.mimetype
            },
            metadata: {
                originalName: req.file.originalname,
                uploadDate: new Date().toISOString(),
                fileSize: req.file.size.toString(),
                extractedTextFile: textFileName
            }
        });

        console.log('✅ Image uploaded to blob storage');
        console.log('🤖 Step 2: Running OCR on uploaded image...');

        // Step 2: Process OCR using the uploaded image buffer (or blob URL)
        const ocrResult = await ocrService.processReceipt(req.file.buffer);
        
        console.log('✅ OCR processing completed');
        console.log('💾 Step 3: Saving extracted text to blob storage...');

        // Step 3: Save extracted text as JSON blob
        const extractedData = {
            metadata: {
                originalFileName: req.file.originalname,
                imageFileName: imageFileName,
                imageUrl: imageBlockBlobClient.url,
                extractedAt: new Date().toISOString(),
                ocrConfidence: ocrResult.confidence
            },
            extractedText: ocrResult,
            structuredData: {
                merchantName: ocrResult.merchantName,
                amount: ocrResult.total,
                transactionDate: ocrResult.transactionDate,
                suggestedCategory: ocrResult.suggestedCategory,
                items: ocrResult.items || [],
                rawText: ocrResult.rawText
            }
        };

        const textBlockBlobClient = containerClient.getBlockBlobClient(textFileName);
        const textContent = JSON.stringify(extractedData, null, 2);
        
        await textBlockBlobClient.upload(textContent, textContent.length, {
            blobHTTPHeaders: {
                blobContentType: 'application/json'
            },
            metadata: {
                relatedImageFile: imageFileName,
                extractedAt: new Date().toISOString(),
                merchantName: ocrResult.merchantName || 'unknown'
            }
        });

        console.log('✅ Extracted text saved to blob storage');
        console.log('🎉 Complete workflow finished successfully');

        // Step 4: Return both URLs + extracted text
        const response = {
            success: true,
            message: 'Receipt uploaded and text extracted successfully',
            data: {
                // File information
                originalFileName: req.file.originalname,
                fileSize: req.file.size,
                processedAt: new Date().toISOString(),
                
                // Blob storage URLs
                imageUrl: imageBlockBlobClient.url,
                textUrl: textBlockBlobClient.url,
                
                // File names in storage
                imageFileName: imageFileName,
                textFileName: textFileName,
                
                // Extracted text data (for immediate use)
                extractedText: ocrResult,
                
                // Structured data for frontend
                merchant_name: ocrResult.merchantName,
                amount: parseFloat(ocrResult.total || '0'),
                transaction_date: ocrResult.transactionDate,
                suggested_category: ocrResult.suggestedCategory,
                confidence_score: ocrResult.confidence,
                items: ocrResult.items || [],
                raw_text: ocrResult.rawText,
                
                // Container information
                containerName: containerName
            }
        };

        res.json(response);

    } catch (error) {
        console.error('❌ Complete OCR workflow error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to process receipt',
            error: error.message,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

/**
 * GET /test
 * Serve the complete OCR test page
 */
router.get('/test', (req, res) => {
    const path = require('path');
    res.sendFile(path.join(__dirname, '..', 'complete-ocr-test.html'));
});

/**
 * GET /list-receipts
 * List all processed receipts with their URLs
 */
router.get('/list-receipts', async (req, res) => {
    try {
        const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
        const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || 'receipts';
        
        if (!connectionString) {
            throw new Error('Azure Storage connection string not configured');
        }

        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        const containerClient = blobServiceClient.getContainerClient(containerName);
        
        const receipts = [];
        
        // List all blobs in images folder
        for await (const blob of containerClient.listBlobsFlat({ prefix: 'images/' })) {
            const extractedTextFile = blob.metadata?.extractedTextFile;
            receipts.push({
                imageFile: blob.name,
                imageUrl: `${containerClient.url}/${blob.name}`,
                textFile: extractedTextFile,
                textUrl: extractedTextFile ? `${containerClient.url}/${extractedTextFile}` : null,
                uploadDate: blob.metadata?.uploadDate,
                originalName: blob.metadata?.originalName,
                fileSize: blob.metadata?.fileSize
            });
        }

        res.json({
            success: true,
            message: `Found ${receipts.length} processed receipts`,
            data: {
                containerName,
                totalReceipts: receipts.length,
                receipts: receipts.sort((a, b) => new Date(b.uploadDate) - new Date(a.uploadDate))
            }
        });

    } catch (error) {
        console.error('❌ List receipts error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to list receipts',
            error: error.message
        });
    }
});

module.exports = router;