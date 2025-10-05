// Azure OCR Service for Receipt Processing
const { DocumentAnalysisClient } = require('@azure/ai-form-recognizer');
const { BlobServiceClient } = require('@azure/storage-blob');
const { AzureKeyCredential } = require('@azure/core-auth');
const crypto = require('crypto');
const sharp = require('sharp');

class AzureOCRService {
    constructor() {
        // Initialize Computer Vision client
        const endpoint = process.env.AZURE_COMPUTER_VISION_ENDPOINT;
        const key = process.env.AZURE_COMPUTER_VISION_KEY;
        
        if (!endpoint || !key) {
            throw new Error('Azure Computer Vision credentials not found in environment variables');
        }

        this.client = new DocumentAnalysisClient(endpoint, new AzureKeyCredential(key));
        
        // Initialize Blob Storage client  
        const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
        const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || 'receipts';
        
        if (!connectionString) {
            throw new Error('Azure Storage connection string not found in environment variables');
        }

        this.blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        this.containerName = containerName;
        
        console.log('✅ Azure OCR Service initialized successfully');
    }

    /**
     * Upload receipt image to Azure Blob Storage
     */
    async uploadReceiptImage(buffer, originalName, userId) {
        try {
            // Generate unique filename
            const fileExtension = originalName.split('.').pop().toLowerCase();
            const fileName = `${userId}/${crypto.randomUUID()}.${fileExtension}`;
            
            // Get container client
            const containerClient = this.blobServiceClient.getContainerClient(this.containerName);
            
            // Optimize image before upload
            const optimizedBuffer = await this.optimizeImage(buffer);
            
            // Upload to blob storage
            const blockBlobClient = containerClient.getBlockBlobClient(fileName);
            await blockBlobClient.upload(optimizedBuffer, optimizedBuffer.length, {
                blobHTTPHeaders: {
                    blobContentType: `image/${fileExtension}`
                },
                metadata: {
                    userId: userId.toString(),
                    originalName: originalName,
                    uploadDate: new Date().toISOString()
                }
            });

            console.log(`✅ Receipt image uploaded: ${fileName}`);
            return {
                fileName,
                url: blockBlobClient.url,
                size: optimizedBuffer.length
            };
        } catch (error) {
            console.error('❌ Error uploading receipt image:', error);
            throw new Error(`Failed to upload receipt image: ${error.message}`);
        }
    }

    /**
     * Optimize image for OCR processing
     */
    async optimizeImage(buffer) {
        try {
            const optimized = await sharp(buffer)
                .resize(2000, 2000, { 
                    fit: 'inside', 
                    withoutEnlargement: true 
                })
                .jpeg({ 
                    quality: 85,
                    progressive: true
                })
                .toBuffer();

            console.log('✅ Image optimized for OCR');
            return optimized;
        } catch (error) {
            console.error('❌ Error optimizing image:', error);
            // Return original buffer if optimization fails
            return buffer;
        }
    }

    /**
     * Process receipt using Azure Form Recognizer
     */
    async processReceipt(imageBuffer) {
        try {
            console.log('🔄 Starting OCR processing...');
            
            // Use prebuilt receipt model
            const poller = await this.client.beginAnalyzeDocument('prebuilt-receipt', imageBuffer);
            const result = await poller.pollUntilDone();

            if (!result.documents || result.documents.length === 0) {
                throw new Error('No receipt data found in the image');
            }

            const receipt = result.documents[0];
            const extractedData = this.extractReceiptData(receipt);
            
            console.log('✅ OCR processing completed');
            console.log('📊 Extracted data:', JSON.stringify(extractedData, null, 2));
            
            return extractedData;
        } catch (error) {
            console.error('❌ Error processing receipt:', error);
            throw new Error(`Failed to process receipt: ${error.message}`);
        }
    }

    /**
     * Extract structured data from OCR results
     */
    extractReceiptData(receipt) {
        const fields = receipt.fields || {};
        
        // Extract basic receipt information
        const merchantName = fields.MerchantName?.content || 'Unknown Merchant';
        const transactionDate = fields.TransactionDate?.content || new Date().toISOString().split('T')[0];
        const total = fields.Total?.content || fields.SubTotal?.content || '0.00';
        
        // Extract items
        const items = [];
        if (fields.Items?.values) {
            fields.Items.values.forEach(item => {
                const itemFields = item.properties || {};
                items.push({
                    name: itemFields.Name?.content || 'Unknown Item',
                    quantity: itemFields.Quantity?.content || '1',
                    price: itemFields.TotalPrice?.content || itemFields.Price?.content || '0.00'
                });
            });
        }

        // Clean and validate total amount
        const cleanTotal = this.cleanAmount(total);
        
        // Determine likely category based on merchant name
        const suggestedCategory = this.suggestCategory(merchantName);

        return {
            merchantName: merchantName.trim(),
            transactionDate,
            total: cleanTotal,
            items,
            suggestedCategory,
            confidence: receipt.confidence || 0,
            rawText: receipt.content || ''
        };
    }

    /**
     * Clean amount string and convert to decimal
     */
    cleanAmount(amountStr) {
        if (!amountStr) return '0.00';
        
        // Remove currency symbols and clean the string
        const cleaned = amountStr.toString()
            .replace(/[^\d.,\-]/g, '')
            .replace(/,/g, '');
        
        // Convert to float and format to 2 decimal places
        const amount = parseFloat(cleaned) || 0;
        return Math.abs(amount).toFixed(2);
    }

    /**
     * Suggest category based on merchant name
     */
    suggestCategory(merchantName) {
        const name = merchantName.toLowerCase();
        
        // Grocery stores
        if (name.includes('grocery') || name.includes('market') || name.includes('supermarket') || 
            name.includes('walmart') || name.includes('target') || name.includes('costco')) {
            return 'Groceries';
        }
        
        // Restaurants
        if (name.includes('restaurant') || name.includes('cafe') || name.includes('pizza') || 
            name.includes('mcdonald') || name.includes('starbucks') || name.includes('food')) {
            return 'Entertainment';
        }
        
        // Gas stations
        if (name.includes('gas') || name.includes('fuel') || name.includes('shell') || 
            name.includes('bp') || name.includes('chevron') || name.includes('exxon')) {
            return 'Transportation';
        }
        
        // Pharmacies
        if (name.includes('pharmacy') || name.includes('cvs') || name.includes('walgreens') || 
            name.includes('drug')) {
            return 'Healthcare';
        }
        
        // Default category
        return 'Other';
    }

    /**
     * Delete receipt image from storage
     */
    async deleteReceiptImage(fileName) {
        try {
            const containerClient = this.blobServiceClient.getContainerClient(this.containerName);
            const blockBlobClient = containerClient.getBlockBlobClient(fileName);
            await blockBlobClient.delete();
            console.log(`✅ Receipt image deleted: ${fileName}`);
        } catch (error) {
            console.error('❌ Error deleting receipt image:', error);
            // Don't throw error for deletion failures
        }
    }
}

module.exports = AzureOCRService;