const { Pool } = require('pg');

// Database configuration with fallback handling
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'personal_finance_tracker',
    user: process.env.DB_USER || 'finance_user',
    password: process.env.DB_PASSWORD,
    max: parseInt(process.env.DB_MAX_CONNECTIONS) || 20,
    min: parseInt(process.env.DB_MIN_CONNECTIONS) || 2,
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000,
    connectionTimeoutMillis: 5000, // Reduced timeout for faster failure
    maxUses: 7500,
    ssl: process.env.DB_SSL === 'true' ? {
        rejectUnauthorized: false,
        sslmode: 'require'
    } : false,
    options: '--search_path=finance,public'
};

// Create connection pool
const pool = new Pool(dbConfig);

// Track database availability
let isDatabaseConnected = false;

// Pool error handling
pool.on('error', (err, client) => {
    console.error('Unexpected error on idle client', err);
    isDatabaseConnected = false;
});

pool.on('connect', async (client) => {
    console.log('✅ New client connected to database');
    isDatabaseConnected = true;
    try {
        await client.query('SET search_path TO finance, public');
    } catch (err) {
        console.error('Error setting search path:', err);
    }
});

// Graceful database query wrapper
async function safeQuery(text, params) {
    if (!isDatabaseConnected) {
        throw new Error('Database not available - running in fallback mode');
    }
    
    try {
        const client = await pool.connect();
        try {
            const result = await client.query(text, params);
            return result;
        } finally {
            client.release();
        }
    } catch (error) {
        isDatabaseConnected = false;
        throw error;
    }
}

// Health check function with timeout
async function healthCheck() {
    try {
        const client = await pool.connect();
        try {
            await client.query('SELECT 1');
            isDatabaseConnected = true;
            return { status: 'connected', message: 'Database connection healthy' };
        } finally {
            client.release();
        }
    } catch (error) {
        isDatabaseConnected = false;
        return { 
            status: 'disconnected', 
            message: `Database connection failed: ${error.message}`,
            suggestion: 'Check if Azure PostgreSQL server is running'
        };
    }
}

// Test connection on startup with retry
async function initializeDatabase() {
    console.log('🔄 Testing database connection...');
    
    for (let i = 0; i < 3; i++) {
        try {
            const client = await pool.connect();
            await client.query('SELECT 1');
            client.release();
            
            console.log('✅ Database connected successfully');
            
            // Get database info
            const dbInfoClient = await pool.connect();
            try {
                const timeResult = await dbInfoClient.query('SELECT NOW() as current_time');
                const versionResult = await dbInfoClient.query('SELECT version()');
                
                console.log(`📅 Database time: ${timeResult.rows[0].current_time}`);
                console.log(`🐘 PostgreSQL version: ${versionResult.rows[0].version.split(' ').slice(0, 3).join(' ')}`);
                
                isDatabaseConnected = true;
                return true;
            } finally {
                dbInfoClient.release();
            }
        } catch (error) {
            console.log(`❌ Database connection attempt ${i + 1}/3 failed: ${error.message}`);
            if (i < 2) {
                console.log('⏳ Retrying in 2 seconds...');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }
    
    console.log('⚠️  Database connection failed - server will run in fallback mode');
    console.log('💡 OCR functionality will still work, but user data will be mocked');
    isDatabaseConnected = false;
    return false;
}

module.exports = {
    pool,
    safeQuery,
    healthCheck,
    initializeDatabase,
    isDatabaseConnected: () => isDatabaseConnected
};