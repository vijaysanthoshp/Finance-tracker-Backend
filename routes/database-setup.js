const express = require('express');
const { pool } = require('../config/database');

const router = express.Router();

// Test endpoint to create receipts table
router.post('/create-receipts-table', async (req, res) => {
    const client = await pool.connect();
    
    try {
        console.log('🏗️ Creating receipts table...');
        
        // Set schema
        await client.query('SET search_path TO finance, public');
        
        // Create receipts table
        await client.query(`
            CREATE TABLE IF NOT EXISTS receipts (
                receipt_id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                merchant_name VARCHAR(255),
                amount DECIMAL(12,2),
                transaction_date DATE,
                suggested_category VARCHAR(100),
                confidence_score DECIMAL(5,4),
                image_url TEXT NOT NULL,
                image_filename VARCHAR(500) NOT NULL,
                ocr_data JSONB,
                transaction_created BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Create indexes
        await client.query('CREATE INDEX IF NOT EXISTS idx_receipts_user_id ON receipts(user_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_receipts_created_at ON receipts(created_at DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_receipts_merchant_name ON receipts(merchant_name)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_receipts_transaction_created ON receipts(transaction_created)');
        
        // Add receipt_id column to transactions table
        await client.query('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receipt_id INTEGER REFERENCES receipts(receipt_id) ON DELETE SET NULL');
        await client.query('CREATE INDEX IF NOT EXISTS idx_transactions_receipt_id ON transactions(receipt_id)');
        
        console.log('✅ Receipts table created successfully!');
        
        // Verify table exists
        const result = await client.query("SELECT table_name FROM information_schema.tables WHERE table_name = 'receipts' AND table_schema = 'finance'");
        
        res.json({
            success: true,
            message: 'Receipts table created successfully',
            tableExists: result.rows.length > 0
        });
        
    } catch (error) {
        console.error('❌ Error creating receipts table:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create receipts table',
            error: error.message
        });
    } finally {
        client.release();
    }
});

// Test endpoint to check if receipts table exists
router.get('/check-receipts-table', async (req, res) => {
    try {
        const result = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_name = 'receipts' AND table_schema = 'finance'");
        
        res.json({
            success: true,
            tableExists: result.rows.length > 0,
            message: result.rows.length > 0 ? 'Receipts table exists' : 'Receipts table does not exist'
        });
        
    } catch (error) {
        console.error('❌ Error checking receipts table:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check receipts table',
            error: error.message
        });
    }
});

module.exports = router;