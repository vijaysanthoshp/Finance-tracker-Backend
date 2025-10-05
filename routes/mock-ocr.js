const express = require('express');
const multer = require('multer');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Mock OCR response - this simulates the Azure OCR JSON structure you provided
const mockOcrResponse = {
    "status": "succeeded",
    "createdDateTime": new Date().toISOString(),
    "lastUpdatedDateTime": new Date().toISOString(),
    "analyzeResult": {
        "version": "3.2.0",
        "modelVersion": "2022-04-30",
        "readResults": [
            {
                "page": 1,
                "angle": 0,
                "width": 676,
                "height": 1288,
                "unit": "pixel",
                "lines": [
                    {
                        "boundingBox": [217, 140, 461, 139, 461, 185, 217, 186],
                        "text": "RECEIPT",
                        "words": [{"text": "RECEIPT", "confidence": 0.994}]
                    },
                    {
                        "boundingBox": [85, 290, 286, 291, 286, 321, 85, 318],
                        "text": "1x Lorem ipsum",
                        "words": [
                            {"text": "1x", "confidence": 0.959},
                            {"text": "Lorem", "confidence": 0.997},
                            {"text": "ipsum", "confidence": 0.998}
                        ]
                    },
                    {
                        "boundingBox": [520, 289, 590, 291, 590, 319, 518, 317],
                        "text": "35.00",
                        "words": [{"text": "35.00", "confidence": 0.997}]
                    },
                    {
                        "boundingBox": [85, 333, 289, 334, 289, 365, 84, 364],
                        "text": "2x Lorem ipsum",
                        "words": [
                            {"text": "2x", "confidence": 0.998},
                            {"text": "Lorem", "confidence": 0.997},
                            {"text": "ipsum", "confidence": 0.997}
                        ]
                    },
                    {
                        "boundingBox": [518, 335, 590, 336, 590, 360, 518, 359],
                        "text": "15.00",
                        "words": [{"text": "15.00", "confidence": 0.998}]
                    },
                    {
                        "boundingBox": [84, 375, 286, 377, 286, 408, 84, 406],
                        "text": "1x Lorem ipsum",
                        "words": [
                            {"text": "1x", "confidence": 0.95},
                            {"text": "Lorem", "confidence": 0.997},
                            {"text": "ipsum", "confidence": 0.997}
                        ]
                    },
                    {
                        "boundingBox": [518, 379, 589, 379, 589, 403, 518, 403],
                        "text": "30.00",
                        "words": [{"text": "30.00", "confidence": 0.997}]
                    },
                    {
                        "boundingBox": [85, 422, 285, 425, 285, 454, 84, 452],
                        "text": "1x Lorem ipsum",
                        "words": [
                            {"text": "1x", "confidence": 0.991},
                            {"text": "Lorem", "confidence": 0.997},
                            {"text": "ipsum", "confidence": 0.998}
                        ]
                    },
                    {
                        "boundingBox": [518, 426, 589, 426, 589, 450, 518, 450],
                        "text": "10.00",
                        "words": [{"text": "10.00", "confidence": 0.991}]
                    },
                    {
                        "boundingBox": [85, 467, 288, 467, 288, 497, 85, 496],
                        "text": "2x Lorem ipsum",
                        "words": [
                            {"text": "2x", "confidence": 0.994},
                            {"text": "Lorem", "confidence": 0.998},
                            {"text": "ipsum", "confidence": 0.998}
                        ]
                    },
                    {
                        "boundingBox": [519, 467, 589, 467, 590, 492, 519, 492],
                        "text": "10.00",
                        "words": [{"text": "10.00", "confidence": 0.991}]
                    },
                    {
                        "boundingBox": [83, 509, 286, 511, 285, 541, 83, 539],
                        "text": "1x Lorem ipsum",
                        "words": [
                            {"text": "1x", "confidence": 0.895},
                            {"text": "Lorem", "confidence": 0.997},
                            {"text": "ipsum", "confidence": 0.998}
                        ]
                    },
                    {
                        "boundingBox": [534, 513, 589, 512, 589, 536, 534, 535],
                        "text": "7.00",
                        "words": [{"text": "7.00", "confidence": 0.988}]
                    },
                    {
                        "boundingBox": [84, 556, 287, 557, 287, 585, 84, 583],
                        "text": "1x Lorem ipsum",
                        "words": [
                            {"text": "1x", "confidence": 0.97},
                            {"text": "Lorem", "confidence": 0.997},
                            {"text": "ipsum", "confidence": 0.998}
                        ]
                    },
                    {
                        "boundingBox": [518, 556, 589, 557, 589, 579, 518, 579],
                        "text": "10.00",
                        "words": [{"text": "10.00", "confidence": 0.998}]
                    },
                    {
                        "boundingBox": [101, 652, 291, 652, 291, 675, 101, 675],
                        "text": "TOTAL AMOUNT",
                        "words": [
                            {"text": "TOTAL", "confidence": 0.998},
                            {"text": "AMOUNT", "confidence": 0.997}
                        ]
                    },
                    {
                        "boundingBox": [492, 653, 586, 653, 586, 675, 492, 676],
                        "text": "$ 117.00",
                        "words": [
                            {"text": "$", "confidence": 0.995},
                            {"text": "117.00", "confidence": 0.996}
                        ]
                    },
                    {
                        "boundingBox": [101, 747, 178, 747, 178, 769, 101, 770],
                        "text": "CASH",
                        "words": [{"text": "CASH", "confidence": 0.989}]
                    },
                    {
                        "boundingBox": [477, 747, 586, 747, 587, 771, 477, 772],
                        "text": "$ 200.00",
                        "words": [
                            {"text": "$", "confidence": 0.995},
                            {"text": "200.00", "confidence": 0.997}
                        ]
                    },
                    {
                        "boundingBox": [101, 786, 216, 786, 216, 808, 101, 808],
                        "text": "CHANGE",
                        "words": [{"text": "CHANGE", "confidence": 0.994}]
                    },
                    {
                        "boundingBox": [477, 786, 573, 786, 573, 809, 477, 810],
                        "text": "$ 83.00",
                        "words": [
                            {"text": "$", "confidence": 0.995},
                            {"text": "83.00", "confidence": 0.994}
                        ]
                    },
                    {
                        "boundingBox": [187, 924, 485, 923, 485, 963, 187, 964],
                        "text": "THANK YOU",
                        "words": [
                            {"text": "THANK", "confidence": 0.998},
                            {"text": "YOU", "confidence": 0.991}
                        ]
                    }
                ]
            }
        ]
    }
};

/**
 * Extract readable text from OCR JSON structure
 */
function extractTextFromOcrJson(ocrData) {
    const readResults = ocrData.analyzeResult?.readResults || [];
    let extractedText = '';
    let totalConfidence = 0;
    let wordCount = 0;
    
    for (const page of readResults) {
        const lines = page.lines || [];
        for (const line of lines) {
            extractedText += line.text + '\n';
            
            // Calculate confidence
            if (line.words) {
                for (const word of line.words) {
                    if (word.confidence) {
                        totalConfidence += word.confidence;
                        wordCount++;
                    }
                }
            }
        }
    }
    
    const averageConfidence = wordCount > 0 ? totalConfidence / wordCount : 0;
    
    return {
        text: extractedText.trim(),
        confidence: averageConfidence,
        wordCount: wordCount,
        lines: readResults[0]?.lines || []
    };
}

/**
 * Parse receipt text to extract structured data
 */
function parseReceiptData(extractedText) {
    const lines = extractedText.split('\n');
    let merchantName = '';
    let totalAmount = '';
    let items = [];
    
    // Extract merchant (usually first meaningful line)
    if (lines.length > 0 && lines[0] !== 'RECEIPT') {
        merchantName = lines[0];
    } else if (lines.length > 1) {
        merchantName = lines[1];
    }
    
    // Extract total amount
    const totalMatch = extractedText.match(/TOTAL.*?\$?\s*(\d+\.\d{2})/i);
    if (totalMatch) {
        totalAmount = totalMatch[1];
    }
    
    // Extract items (lines with quantity and price pattern)
    for (const line of lines) {
        const itemMatch = line.match(/(\d+x?\s+.*?)(\$?\s*\d+\.\d{2})/i);
        if (itemMatch) {
            items.push({
                description: itemMatch[1].trim(),
                price: itemMatch[2].replace('$', '').trim()
            });
        }
    }
    
    return {
        merchantName: merchantName || 'Unknown Store',
        totalAmount: totalAmount || '0.00',
        items: items,
        transactionDate: new Date().toISOString().split('T')[0]
    };
}

/**
 * POST /upload
 * Mock OCR processing - returns extracted text from mock JSON data
 */
router.post('/upload', upload.single('file'), async (req, res) => {
    try {
        console.log('📤 Mock OCR: Processing uploaded file...');
        
        if (!req.file) {
            return res.status(400).json({ 
                success: false, 
                error: 'No file uploaded' 
            });
        }
        
        console.log(`📄 File: ${req.file.originalname} (${req.file.size} bytes)`);
        
        // Simulate processing delay
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        // Extract text from mock OCR data
        const extractionResult = extractTextFromOcrJson(mockOcrResponse);
        const parsedData = parseReceiptData(extractionResult.text);
        
        console.log('✅ Mock OCR completed successfully');
        
        // Return response in format expected by frontend
        const response = {
            success: true,
            message: 'Receipt processed successfully (Mock OCR)',
            data: {
                // Raw extracted text
                text: extractionResult.text,
                extractedText: extractionResult.text,
                
                // Parsed receipt data
                merchant_name: parsedData.merchantName,
                amount: parseFloat(parsedData.totalAmount),
                transaction_date: parsedData.transactionDate,
                confidence_score: extractionResult.confidence,
                
                // Additional data
                items: parsedData.items,
                raw_text: extractionResult.text,
                word_count: extractionResult.wordCount,
                
                // File info
                originalFileName: req.file.originalname,
                fileSize: req.file.size,
                processedAt: new Date().toISOString(),
                
                // Complete OCR JSON for debugging
                fullOcrResponse: mockOcrResponse
            }
        };
        
        res.json(response);
        
    } catch (error) {
        console.error('❌ Mock OCR error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /sample-json
 * Returns the sample OCR JSON structure for reference
 */
router.get('/sample-json', (req, res) => {
    res.json({
        message: 'Sample OCR JSON Response',
        sampleData: mockOcrResponse,
        extractedText: extractTextFromOcrJson(mockOcrResponse)
    });
});

/**
 * GET /health
 * Health check for mock OCR service
 */
router.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'Mock OCR Service',
        timestamp: new Date().toISOString(),
        message: 'Ready to process files with mock OCR data'
    });
});

module.exports = router;