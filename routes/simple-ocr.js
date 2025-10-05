// Simple OCR Upload Route
const express = require('express');
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
 * POST /extract-text
 * Simple OCR: Upload image → Extract text → Return results (no storage)
 */
router.post('/extract-text', upload.single('file'), async (req, res) => {
    try {
        console.log('📤 OCR request received');
        
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No image file provided'
            });
        }

        console.log(`🔍 Processing: ${req.file.originalname} (${req.file.size} bytes)`);

        // Initialize OCR service
        const ocrService = new AzureOCRService();
        
        // Process with OCR
        const ocrResult = await ocrService.processReceipt(req.file.buffer);
        
        console.log('✅ OCR completed successfully');

        // Return results
        res.json({
            success: true,
            message: 'Text extraction completed',
            data: {
                fileName: req.file.originalname,
                fileSize: req.file.size,
                extractedText: ocrResult,
                processedAt: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('❌ OCR Error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Text extraction failed',
            error: error.message
        });
    }
});

/**
 * GET /test
 * Simple test page for OCR
 */
router.get('/test', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Simple OCR Test</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
        .upload-area { border: 2px dashed #ccc; padding: 40px; text-align: center; margin: 20px 0; }
        button { padding: 10px 20px; background: #007bff; color: white; border: none; border-radius: 5px; cursor: pointer; }
        button:hover { background: #0056b3; }
        .result { margin: 20px 0; padding: 15px; border-radius: 5px; }
        .success { background: #d4edda; color: #155724; }
        .error { background: #f8d7da; color: #721c24; }
        .loading { background: #fff3cd; color: #856404; }
    </style>
</head>
<body>
    <h1>🔍 Simple OCR Text Extractor</h1>
    
    <div class="upload-area">
        <input type="file" id="fileInput" accept="image/*" required>
        <br><br>
        <button onclick="extractText()">Extract Text</button>
    </div>
    
    <div id="result"></div>

    <script>
        async function extractText() {
            const fileInput = document.getElementById('fileInput');
            const resultDiv = document.getElementById('result');
            
            if (!fileInput.files[0]) {
                resultDiv.className = 'result error';
                resultDiv.innerHTML = 'Please select an image file';
                return;
            }
            
            const formData = new FormData();
            formData.append('file', fileInput.files[0]);
            
            resultDiv.className = 'result loading';
            resultDiv.innerHTML = 'Extracting text...';
            
            try {
                const response = await fetch('/api/v1/simple-ocr/extract-text', {
                    method: 'POST',
                    body: formData
                });
                
                const result = await response.json();
                
                if (result.success) {
                    const ocr = result.data.extractedText;
                    resultDiv.className = 'result success';
                    resultDiv.innerHTML = \`
                        <h3>✅ Text Extracted Successfully!</h3>
                        <p><strong>File:</strong> \${result.data.fileName}</p>
                        <p><strong>Merchant:</strong> \${ocr.merchantName || 'Not detected'}</p>
                        <p><strong>Amount:</strong> $\${ocr.total || '0.00'}</p>
                        <p><strong>Date:</strong> \${ocr.transactionDate || 'Not detected'}</p>
                        <p><strong>Category:</strong> \${ocr.suggestedCategory || 'Other'}</p>
                        <details>
                            <summary>Raw Text</summary>
                            <pre>\${ocr.rawText || 'No raw text available'}</pre>
                        </details>
                    \`;
                } else {
                    resultDiv.className = 'result error';
                    resultDiv.innerHTML = \`<h3>❌ Error:</h3><p>\${result.message}</p>\`;
                }
            } catch (error) {
                resultDiv.className = 'result error';
                resultDiv.innerHTML = \`<h3>❌ Network Error:</h3><p>\${error.message}</p>\`;
            }
        }
    </script>
</body>
</html>
    `);
});

module.exports = router;