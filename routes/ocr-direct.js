const express = require('express');
const multer = require('multer');
const { safeQuery, isDatabaseConnected } = require('../config/database-safe');

const router = express.Router();

// Configure multer for memory storage
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
    }
});

// Import Azure services from existing modules
let ocrService = null;

try {
    // Try to import the existing OCR service
    const path = require('path');
    const fs = require('fs');
    
    // Use the existing Azure configuration from the receipts-safe module
    console.log('✅ Azure OCR services will be initialized from existing configuration');
} catch (error) {
    console.error('❌ Error accessing Azure services:', error.message);
}

/**
 * POST /receipts/ocr-only
 * Direct OCR processing without authentication - for testing only
 */
router.post('/ocr-only', upload.single('receipt'), async (req, res) => {
    try {
        console.log('🤖 Direct OCR processing request received');
        
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No receipt image provided'
            });
        }

        console.log(`📄 Processing image: ${req.file.originalname} (${req.file.size} bytes)`);

        // For now, create mock OCR results to test the interface
        // This simulates what Azure Computer Vision would return
        const mockOcrResult = createMockOCRResult(req.file.originalname);

        console.log('✅ Mock OCR processing completed successfully');
        console.log(`💰 Detected amount: $${mockOcrResult.amount || '0.00'}`);
        console.log(`🏪 Detected merchant: ${mockOcrResult.merchantName || 'Unknown'}`);
        
        res.json({
            success: true,
            data: mockOcrResult
        });

    } catch (error) {
        console.error('❌ OCR processing error:', error);
        res.status(500).json({
            success: false,
            message: `OCR processing failed: ${error.message}`,
            error: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

/**
 * Create mock OCR results for testing
 */
function createMockOCRResult(filename) {
    // Create realistic mock data based on filename or random
    const merchants = ['Starbucks', 'Target', 'Walmart', 'CVS Pharmacy', 'Shell Gas Station', 'McDonald\'s', 'Home Depot'];
    const categories = ['Food & Dining', 'Shopping', 'Groceries', 'Healthcare', 'Transportation', 'Food & Dining', 'Home & Garden'];
    
    const randomIndex = Math.floor(Math.random() * merchants.length);
    const merchant = merchants[randomIndex];
    const category = categories[randomIndex];
    
    const amount = (Math.random() * 150 + 5).toFixed(2); // $5 - $155
    const confidence = 0.85 + (Math.random() * 0.1); // 85% - 95%
    
    const items = [
        { description: 'Coffee Latte', price: 4.95, totalPrice: 4.95, quantity: 1 },
        { description: 'Blueberry Muffin', price: 2.50, totalPrice: 2.50, quantity: 1 },
        { description: 'Tax', price: 0.67, totalPrice: 0.67, quantity: 1 }
    ];
    
    const today = new Date();
    const receiptDate = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;
    
    return {
        merchantName: merchant,
        amount: parseFloat(amount),
        date: receiptDate,
        items: items,
        suggestedCategory: category,
        confidence: confidence,
        totalLines: 15,
        totalWords: 45,
        extractedText: [
            merchant,
            'Store #1234',
            '123 Main Street',
            'Receipt #: ABC123',
            'Coffee Latte        $4.95',
            'Blueberry Muffin    $2.50',
            'Subtotal           $7.45',
            'Tax                $0.67',
            `Total              $${amount}`,
            'Payment: Credit Card',
            `Date: ${receiptDate}`,
            'Thank you for visiting!'
        ],
        processingTime: new Date().toISOString(),
        rawOcrResult: {
            status: 'succeeded',
            pages: 1
        },
        imageUrl: null,
        mockData: true,
        message: 'This is mock OCR data for testing. Real Azure Computer Vision integration will replace this.'
    };
}

/**
 * Analyze extracted text to find receipt information
 */
function analyzeReceiptText(textLines, words) {
    const receiptData = {
        merchantName: null,
        amount: null,
        date: null,
        items: [],
        suggestedCategory: null
    };

    // Join all text for analysis
    const fullText = textLines.join(' ').toLowerCase();
    
    // Extract merchant name (usually first few lines)
    if (textLines.length > 0) {
        // Try to find merchant in first 3 lines
        for (let i = 0; i < Math.min(3, textLines.length); i++) {
            const line = textLines[i].trim();
            if (line.length > 2 && !line.match(/^\d+[\d\s\-\/\.]*$/)) {
                receiptData.merchantName = line;
                break;
            }
        }
    }

    // Extract total amount (look for patterns like "TOTAL", "AMOUNT", etc.)
    const amountPatterns = [
        /total[\s:]*\$?([\d,]+\.?\d*)/i,
        /amount[\s:]*\$?([\d,]+\.?\d*)/i,
        /balance[\s:]*\$?([\d,]+\.?\d*)/i,
        /\$\s*([\d,]+\.\d{2})\s*(?:total|amount|balance)/i,
        /\$\s*([\d,]+\.\d{2})\s*$/m
    ];

    for (const pattern of amountPatterns) {
        const match = fullText.match(pattern);
        if (match) {
            receiptData.amount = parseFloat(match[1].replace(',', ''));
            break;
        }
    }

    // Extract date
    const datePatterns = [
        /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/,
        /(\d{2,4}[\/\-]\d{1,2}[\/\-]\d{1,2})/,
        /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2},?\s+\d{2,4}/i
    ];

    for (const pattern of datePatterns) {
        const match = fullText.match(pattern);
        if (match) {
            receiptData.date = match[1];
            break;
        }
    }

    // Extract items (lines with price patterns)
    const itemLines = textLines.filter(line => {
        return line.match(/\$?\d+\.?\d*/) && 
               !line.toLowerCase().match(/total|tax|subtotal|change|balance/);
    });

    receiptData.items = itemLines.slice(0, 10).map((line, index) => {
        const priceMatch = line.match(/\$?([\d,]+\.?\d*)/);
        const price = priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : 0;
        
        return {
            description: line.replace(/\$?[\d,]+\.?\d*/g, '').trim() || `Item ${index + 1}`,
            price: price,
            totalPrice: price
        };
    });

    // Suggest category based on merchant name
    if (receiptData.merchantName) {
        receiptData.suggestedCategory = categorizeReceipt(receiptData.merchantName);
    }

    return receiptData;
}

/**
 * Categorize receipt based on merchant name
 */
function categorizeReceipt(merchantName) {
    const merchant = merchantName.toLowerCase();
    
    if (merchant.includes('starbucks') || merchant.includes('coffee') || merchant.includes('cafe')) {
        return 'Food & Dining';
    } else if (merchant.includes('gas') || merchant.includes('shell') || merchant.includes('exxon') || merchant.includes('bp')) {
        return 'Transportation';
    } else if (merchant.includes('grocery') || merchant.includes('market') || merchant.includes('food')) {
        return 'Groceries';
    } else if (merchant.includes('pharmacy') || merchant.includes('cvs') || merchant.includes('walgreens')) {
        return 'Healthcare';
    } else if (merchant.includes('walmart') || merchant.includes('target') || merchant.includes('store')) {
        return 'Shopping';
    } else {
        return 'General';
    }
}

module.exports = router;