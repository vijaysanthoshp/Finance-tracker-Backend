// Azure Blob Storage Checker Route
const express = require('express');
const { BlobServiceClient } = require('@azure/storage-blob');
const AzureOCRService = require('../services/ocrService');
const multer = require('multer');

const router = express.Router();

// Multer configuration for file uploads
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

/**
 * GET /check-blob-storage
 * Check Azure Blob Storage connectivity and list containers
 */
router.get('/check-blob-storage', async (req, res) => {
    try {
        const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
        
        if (!connectionString) {
            return res.status(500).json({
                success: false,
                message: 'Azure Storage connection string not configured',
                details: 'AZURE_STORAGE_CONNECTION_STRING environment variable is missing'
            });
        }

        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        
        // List containers
        const containers = [];
        for await (const container of blobServiceClient.listContainers()) {
            containers.push({
                name: container.name,
                properties: container.properties
            });
        }

        // Check if receipts container exists
        const receiptsContainer = containers.find(c => c.name === 'receipts');
        
        res.json({
            success: true,
            message: 'Azure Blob Storage connection successful',
            data: {
                connectionStatus: 'Connected',
                accountName: blobServiceClient.accountName,
                totalContainers: containers.length,
                containers: containers,
                receiptsContainerExists: !!receiptsContainer,
                receiptsContainer: receiptsContainer || null
            }
        });

    } catch (error) {
        console.error('❌ Blob Storage check error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to connect to Azure Blob Storage',
            error: error.message,
            details: 'Check your AZURE_STORAGE_CONNECTION_STRING and network connectivity'
        });
    }
});

/**
 * GET /list-blobs/:containerName
 * List blobs in a specific container
 */
router.get('/list-blobs/:containerName', async (req, res) => {
    try {
        const { containerName } = req.params;
        const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
        
        if (!connectionString) {
            return res.status(500).json({
                success: false,
                message: 'Azure Storage connection string not configured'
            });
        }

        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        const containerClient = blobServiceClient.getContainerClient(containerName);
        
        // Check if container exists
        const exists = await containerClient.exists();
        if (!exists) {
            return res.status(404).json({
                success: false,
                message: `Container '${containerName}' does not exist`
            });
        }

        // List blobs
        const blobs = [];
        for await (const blob of containerClient.listBlobsFlat()) {
            blobs.push({
                name: blob.name,
                properties: blob.properties,
                metadata: blob.metadata
            });
        }

        res.json({
            success: true,
            message: `Blobs in container '${containerName}'`,
            data: {
                containerName,
                totalBlobs: blobs.length,
                blobs: blobs.slice(0, 20) // Show first 20 blobs
            }
        });

    } catch (error) {
        console.error('❌ List blobs error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to list blobs',
            error: error.message
        });
    }
});

/**
 * POST /ocr-only
 * Just process image with OCR and return text (no storage)
 */
router.post('/ocr-only', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No image file provided'
            });
        }

        console.log(`🔍 Processing OCR only for: ${req.file.originalname}`);

        // Initialize OCR service
        const ocrService = new AzureOCRService();
        
        // Process with OCR only
        const ocrResult = await ocrService.processReceipt(req.file.buffer);
        
        console.log(`✅ OCR completed for: ${req.file.originalname}`);

        res.json({
            success: true,
            message: 'OCR processing completed successfully',
            data: {
                fileName: req.file.originalname,
                fileSize: req.file.size,
                ocrResult: ocrResult,
                processedAt: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('❌ OCR processing error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to process OCR',
            error: error.message
        });
    }
});

/**
 * POST /upload-to-blob
 * Simple upload: image to blob storage + OCR text as separate blob
 */
router.post('/upload-to-blob', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No image file provided'
            });
        }

        console.log(`📤 Processing blob upload: ${req.file.originalname}`);

        // Initialize OCR service
        const ocrService = new AzureOCRService();
        
        // Generate unique filename
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileExtension = req.file.originalname.split('.').pop().toLowerCase();
        const imageFileName = `images/${timestamp}-${req.file.originalname}`;
        const textFileName = `ocr-text/${timestamp}-ocr-result.json`;

        const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
        const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || 'receipts';
        
        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        const containerClient = blobServiceClient.getContainerClient(containerName);

        // Ensure container exists (private access)
        await containerClient.createIfNotExists();

        // 1. Upload image to blob storage
        const imageBlockBlobClient = containerClient.getBlockBlobClient(imageFileName);
        await imageBlockBlobClient.upload(req.file.buffer, req.file.buffer.length, {
            blobHTTPHeaders: {
                blobContentType: req.file.mimetype
            },
            metadata: {
                originalName: req.file.originalname,
                uploadDate: new Date().toISOString(),
                fileSize: req.file.size.toString()
            }
        });

        console.log(`✅ Image uploaded to blob: ${imageFileName}`);

        // 2. Process with OCR
        const ocrResult = await ocrService.processReceipt(req.file.buffer);
        
        // 3. Store OCR result as JSON blob
        const ocrData = {
            imageFileName: imageFileName,
            imageUrl: imageBlockBlobClient.url,
            ocrResult: ocrResult,
            processedAt: new Date().toISOString(),
            originalFilename: req.file.originalname
        };

        const textBlockBlobClient = containerClient.getBlockBlobClient(textFileName);
        await textBlockBlobClient.upload(
            JSON.stringify(ocrData, null, 2), 
            JSON.stringify(ocrData, null, 2).length,
            {
                blobHTTPHeaders: {
                    blobContentType: 'application/json'
                },
                metadata: {
                    relatedImage: imageFileName,
                    processedAt: new Date().toISOString()
                }
            }
        );

        console.log(`✅ OCR result stored to blob: ${textFileName}`);

        res.json({
            success: true,
            message: 'Image and OCR text successfully uploaded to Azure Blob Storage',
            data: {
                imageFile: {
                    name: imageFileName,
                    url: imageBlockBlobClient.url,
                    size: req.file.size
                },
                textFile: {
                    name: textFileName,
                    url: textBlockBlobClient.url,
                    size: JSON.stringify(ocrData, null, 2).length
                },
                ocrResult: ocrResult,
                container: containerName
            }
        });

    } catch (error) {
        console.error('❌ Blob upload error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to upload to blob storage',
            error: error.message,
            details: error.stack
        });
    }
});

/**
 * POST /create-receipts-container
 * Create the receipts container if it doesn't exist
 */
router.post('/create-receipts-container', async (req, res) => {
    try {
        const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
        const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || 'receipts';
        
        if (!connectionString) {
            return res.status(500).json({
                success: false,
                message: 'Azure Storage connection string not configured'
            });
        }

        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        const containerClient = blobServiceClient.getContainerClient(containerName);
        
        const response = await containerClient.createIfNotExists();

        res.json({
            success: true,
            message: response.succeeded ? 
                `Container '${containerName}' created successfully` : 
                `Container '${containerName}' already exists`,
            data: {
                containerName,
                created: response.succeeded,
                url: containerClient.url
            }
        });

    } catch (error) {
        console.error('❌ Container creation error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create container',
            error: error.message
        });
    }
});

module.exports = router;