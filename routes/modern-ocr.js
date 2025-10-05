const express = require('express');
const multer = require('multer');
const axios = require('axios');
const { BlobServiceClient } = require('@azure/storage-blob');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Environment variables
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const AZURE_STORAGE_CONTAINER_NAME = process.env.AZURE_STORAGE_CONTAINER_NAME || 'receipts';
const AZURE_VISION_ENDPOINT = process.env.AZURE_COMPUTER_VISION_ENDPOINT;
const AZURE_VISION_KEY = process.env.AZURE_COMPUTER_VISION_KEY;

/**
 * POST /upload
 * Complete Modern OCR Workflow: Upload → Blob Storage → OCR → Save Text → Return URLs
 */
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    console.log('🚀 Starting modern OCR workflow...');
    
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No file uploaded' 
      });
    }

    // Validate environment variables
    if (!AZURE_STORAGE_CONNECTION_STRING || !AZURE_VISION_ENDPOINT || !AZURE_VISION_KEY) {
      throw new Error('Missing Azure configuration. Please check your environment variables.');
    }

    console.log('📤 Step 1: Uploading to Azure Blob Storage...');
    
    // Step 1: Upload to Azure Blob Storage
    const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
    const containerClient = blobServiceClient.getContainerClient(AZURE_STORAGE_CONTAINER_NAME);
    
    // Ensure container exists
    await containerClient.createIfNotExists({ access: 'container' });
    
    // Generate unique filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileExtension = req.file.originalname.split('.').pop();
    const blobName = `receipts/${timestamp}-${req.file.originalname}`;
    const textBlobName = `extracted-text/${timestamp}-${req.file.originalname.replace(`.${fileExtension}`, '.txt')}`;
    
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    
    // Upload image with metadata
    await blockBlobClient.uploadData(req.file.buffer, {
      blobHTTPHeaders: {
        blobContentType: req.file.mimetype
      },
      metadata: {
        originalName: req.file.originalname,
        uploadDate: new Date().toISOString(),
        fileSize: req.file.size.toString()
      }
    });

    const blobUrl = blockBlobClient.url;
    console.log('✅ Image uploaded to:', blobUrl);

    console.log('🤖 Step 2: Processing OCR with Azure Computer Vision...');
    
    // Step 2: Call Azure Computer Vision Read API (Async)
    const analyzeUrl = `${AZURE_VISION_ENDPOINT}vision/v3.2/read/analyze`;
    
    const ocrResponse = await axios.post(
      analyzeUrl,
      { url: blobUrl },
      {
        headers: {
          'Ocp-Apim-Subscription-Key': AZURE_VISION_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 30000 // 30 second timeout
      }
    );

    // Get the operation location for polling
    const operationLocation = ocrResponse.headers['operation-location'];
    if (!operationLocation) {
      throw new Error('No operation location received from Azure OCR service');
    }

    console.log('⏳ Waiting for OCR processing to complete...');
    
    // Step 3: Poll for OCR results (with retry logic)
    let result;
    let attempts = 0;
    const maxAttempts = 10;
    
    do {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
      attempts++;
      
      try {
        result = await axios.get(operationLocation, {
          headers: { 'Ocp-Apim-Subscription-Key': AZURE_VISION_KEY },
          timeout: 15000
        });
        
        console.log(`📊 OCR Status (attempt ${attempts}): ${result.data.status}`);
        
        if (result.data.status === 'failed') {
          throw new Error('OCR processing failed on Azure side');
        }
        
      } catch (pollError) {
        if (attempts >= maxAttempts) {
          throw new Error(`OCR polling failed after ${maxAttempts} attempts: ${pollError.message}`);
        }
        console.log(`⚠️ Polling attempt ${attempts} failed, retrying...`);
      }
    } while (result?.data?.status !== 'succeeded' && attempts < maxAttempts);

    if (result?.data?.status !== 'succeeded') {
      throw new Error('OCR processing timed out or failed');
    }

    console.log('✅ OCR processing completed successfully');
    
    // Step 4: Extract text from OCR results
    const readResults = result.data.analyzeResult?.readResults || [];
    let extractedText = '';
    let confidence = 0;
    let totalWords = 0;
    
    for (const page of readResults) {
      const lines = page.lines || [];
      for (const line of lines) {
        extractedText += line.text + '\n';
        
        // Calculate average confidence
        if (line.words) {
          for (const word of line.words) {
            if (word.confidence) {
              confidence += word.confidence;
              totalWords++;
            }
          }
        }
      }
    }
    
    const averageConfidence = totalWords > 0 ? confidence / totalWords : 0;
    
    console.log('📝 Step 3: Saving extracted text to Blob Storage...');
    
    // Step 5: Save extracted text as blob
    const textBlobClient = containerClient.getBlockBlobClient(textBlobName);
    const textContent = JSON.stringify({
      metadata: {
        originalFileName: req.file.originalname,
        imageUrl: blobUrl,
        extractedAt: new Date().toISOString(),
        confidence: averageConfidence,
        wordCount: totalWords
      },
      extractedText: extractedText.trim(),
      rawOcrData: result.data.analyzeResult
    }, null, 2);
    
    await textBlobClient.upload(textContent, Buffer.byteLength(textContent), {
      blobHTTPHeaders: {
        blobContentType: 'application/json'
      },
      metadata: {
        relatedImageFile: blobName,
        extractedAt: new Date().toISOString()
      }
    });

    const textBlobUrl = textBlobClient.url;
    console.log('✅ Text saved to:', textBlobUrl);
    
    console.log('🎉 Complete OCR workflow finished successfully!');

    // Step 6: Return comprehensive response
    const response = {
      success: true,
      message: 'Receipt uploaded and processed successfully',
      data: {
        // File information
        originalFileName: req.file.originalname,
        fileSize: req.file.size,
        processedAt: new Date().toISOString(),
        
        // Blob storage URLs
        imageUrl: blobUrl,
        textBlobUrl: textBlobUrl,
        
        // Extracted text and metadata
        extractedText: extractedText.trim(),
        confidence: averageConfidence,
        wordCount: totalWords,
        
        // For frontend compatibility
        text: extractedText.trim(),
        blobUrl: blobUrl // Legacy compatibility
      }
    };

    res.status(200).json(response);

  } catch (error) {
    console.error('❌ Modern OCR workflow error:', error);
    
    // Return detailed error information
    res.status(500).json({
      success: false,
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? {
        stack: error.stack,
        config: {
          hasConnectionString: !!AZURE_STORAGE_CONNECTION_STRING,
          hasVisionEndpoint: !!AZURE_VISION_ENDPOINT,
          hasVisionKey: !!AZURE_VISION_KEY,
          containerName: AZURE_STORAGE_CONTAINER_NAME
        }
      } : undefined
    });
  }
});

/**
 * GET /health
 * Health check for the modern OCR service
 */
router.get('/health', async (req, res) => {
  try {
    // Check Azure configuration
    const config = {
      hasConnectionString: !!AZURE_STORAGE_CONNECTION_STRING,
      hasVisionEndpoint: !!AZURE_VISION_ENDPOINT,
      hasVisionKey: !!AZURE_VISION_KEY,
      containerName: AZURE_STORAGE_CONTAINER_NAME
    };
    
    // Test blob storage connection
    let blobStorageStatus = 'unknown';
    try {
      const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
      const containerClient = blobServiceClient.getContainerClient(AZURE_STORAGE_CONTAINER_NAME);
      await containerClient.getProperties();
      blobStorageStatus = 'connected';
    } catch (blobError) {
      blobStorageStatus = 'error: ' + blobError.message;
    }
    
    res.json({
      status: 'healthy',
      service: 'Modern OCR Service',
      timestamp: new Date().toISOString(),
      config,
      blobStorageStatus
    });
    
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

module.exports = router;