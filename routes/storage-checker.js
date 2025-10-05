const express = require('express');
const { safeQuery, isDatabaseConnected } = require('../config/database-safe');

const router = express.Router();

/**
 * GET /receipts/check-storage
 * Check database storage status for receipts
 */
router.get('/check-storage', async (req, res) => {
    try {
        const result = {
            success: true,
            database: {
                connected: isDatabaseConnected(),
                host: process.env.DB_HOST,
                receiptsTableExists: false,
                totalReceipts: 0
            }
        };

        if (isDatabaseConnected()) {
            try {
                // Check if receipts table exists
                const tableCheck = await safeQuery(`
                    SELECT EXISTS (
                        SELECT FROM information_schema.tables 
                        WHERE table_schema = 'finance' 
                        AND table_name = 'receipts'
                    ) as table_exists;
                `);
                
                result.database.receiptsTableExists = tableCheck[0]?.table_exists || false;

                if (result.database.receiptsTableExists) {
                    // Count total receipts
                    const countResult = await safeQuery(`
                        SELECT COUNT(*) as total FROM finance.receipts;
                    `);
                    result.database.totalReceipts = parseInt(countResult[0]?.total) || 0;
                }
            } catch (dbError) {
                console.error('Database check error:', dbError);
                result.database.error = dbError.message;
            }
        }

        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Storage check failed',
            error: error.message
        });
    }
});

/**
 * GET /receipts/check-blob-storage
 * Check Azure Blob Storage status
 */
router.get('/check-blob-storage', async (req, res) => {
    try {
        const result = {
            success: true,
            storage: {
                configured: false,
                containerName: process.env.AZURE_STORAGE_CONTAINER_NAME || 'receipts',
                totalFiles: 0
            }
        };

        // Check if Azure Storage is configured
        if (process.env.AZURE_STORAGE_CONNECTION_STRING) {
            result.storage.configured = true;
            
            try {
                const { BlobServiceClient } = require('@azure/storage-blob');
                const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
                const containerClient = blobServiceClient.getContainerClient(result.storage.containerName);
                
                // Check if container exists and count files
                const containerExists = await containerClient.exists();
                if (containerExists) {
                    let fileCount = 0;
                    for await (const blob of containerClient.listBlobsFlat()) {
                        fileCount++;
                    }
                    result.storage.totalFiles = fileCount;
                } else {
                    result.storage.error = 'Container does not exist';
                }
            } catch (blobError) {
                console.error('Blob storage check error:', blobError);
                result.storage.error = blobError.message;
            }
        } else {
            result.storage.error = 'Azure Storage connection string not configured';
        }

        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Blob storage check failed',
            error: error.message
        });
    }
});

/**
 * GET /receipts/recent
 * Get recent receipt processing results
 */
router.get('/recent', async (req, res) => {
    try {
        if (!isDatabaseConnected()) {
            return res.json({
                success: false,
                message: 'Database not connected - using mock data',
                receipts: [
                    {
                        receipt_id: 'mock-1',
                        user_id: 1,
                        merchant_name: 'Mock Store',
                        amount: 25.50,
                        transaction_date: '2025-10-04',
                        confidence_score: 0.95,
                        image_filename: 'mock-receipt.jpg',
                        image_url: 'https://example.com/mock-image.jpg',
                        created_at: new Date().toISOString(),
                        ocr_data: {
                            extractedText: ['Mock Store', 'Item 1 $10.00', 'Item 2 $15.50', 'Total $25.50'],
                            confidence: 0.95
                        }
                    }
                ]
            });
        }

        // Get recent receipts from database
        const receipts = await safeQuery(`
            SELECT 
                receipt_id,
                user_id,
                merchant_name,
                amount,
                transaction_date,
                confidence_score,
                image_filename,
                image_url,
                ocr_data,
                transaction_created,
                created_at
            FROM finance.receipts 
            ORDER BY created_at DESC 
            LIMIT 10;
        `);

        res.json({
            success: true,
            receipts: receipts || []
        });

    } catch (error) {
        console.error('Error fetching recent receipts:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch recent receipts',
            error: error.message
        });
    }
});

/**
 * GET /receipts/table-info
 * Get receipts table schema information
 */
router.get('/table-info', async (req, res) => {
    try {
        if (!isDatabaseConnected()) {
            return res.json({
                success: false,
                message: 'Database not connected'
            });
        }

        const columns = await safeQuery(`
            SELECT 
                column_name,
                data_type,
                is_nullable,
                column_default
            FROM information_schema.columns
            WHERE table_schema = 'finance' 
            AND table_name = 'receipts'
            ORDER BY ordinal_position;
        `);

        const indexes = await safeQuery(`
            SELECT indexname, indexdef
            FROM pg_indexes
            WHERE schemaname = 'finance' 
            AND tablename = 'receipts';
        `);

        res.json({
            success: true,
            table: {
                columns: columns || [],
                indexes: indexes || []
            }
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to get table info',
            error: error.message
        });
    }
});

module.exports = router;