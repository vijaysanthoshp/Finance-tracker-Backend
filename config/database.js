const { Pool } = require('pg');

// Database configuration
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'personal_finance_tracker',
    user: process.env.DB_USER || 'finance_user',
    password: process.env.DB_PASSWORD,
    max: parseInt(process.env.DB_MAX_CONNECTIONS) || 20, // Maximum number of clients in the pool
    min: parseInt(process.env.DB_MIN_CONNECTIONS) || 2,  // Minimum number of clients in the pool
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000, // Close idle clients after 30 seconds
    connectionTimeoutMillis: 10000, // Return error after 10 seconds if unable to connect
    maxUses: 7500, // Close connection after 7500 queries
    // SSL configuration for Azure PostgreSQL
    ssl: process.env.DB_SSL === 'true' ? {
        rejectUnauthorized: false,
        sslmode: 'require'
    } : false,
    options: '--search_path=finance,public' // Set search path to include finance schema
};

// Create connection pool
const pool = new Pool(dbConfig);

// Pool error handling
pool.on('error', (err, client) => {
    console.error('Unexpected error on idle client', err);
});

pool.on('connect', async (client) => {
    if (process.env.NODE_ENV === 'development') {
        console.log('New client connected to database');
    }
    // Set search path to include finance schema
    try {
        await client.query('SET search_path TO finance, public');
    } catch (err) {
        console.error('Error setting search path:', err);
    }
});

pool.on('remove', (client) => {
    if (process.env.NODE_ENV === 'development') {
        console.log('Client removed from pool');
    }
});

// Test database connection
const testConnection = async () => {
    try {
        const client = await pool.connect();
        console.log('✅ Database connected successfully');
        
        // Test query
        const result = await client.query('SELECT NOW() as current_time, version() as db_version');
        console.log('📅 Database time:', result.rows[0].current_time);
        console.log('🐘 PostgreSQL version:', result.rows[0].db_version.split(',')[0]);
        
        client.release();
        return true;
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        return false;
    }
};

// Initialize connection test
if (process.env.NODE_ENV !== 'test') {
    testConnection();
}

// Query helper function with error handling
const query = async (text, params) => {
    const start = Date.now();
    try {
        const result = await pool.query(text, params);
        const duration = Date.now() - start;
        
        if (process.env.NODE_ENV === 'development') {
            console.log('📊 Query executed', { 
                text: text.slice(0, 50) + '...', 
                duration: `${duration}ms`, 
                rows: result.rowCount 
            });
        }
        
        return result;
    } catch (error) {
        console.error('🚨 Database query error:', {
            text: text.slice(0, 50) + '...',
            error: error.message,
            duration: `${Date.now() - start}ms`
        });
        throw error;
    }
};

// Transaction helper
const transaction = async (callback) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

// Database health check
const healthCheck = async () => {
    try {
        const client = await pool.connect();
        const result = await client.query('SELECT 1 as health');
        client.release();
        return {
            healthy: true,
            message: 'Database connection is healthy',
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        return {
            healthy: false,
            message: error.message,
            timestamp: new Date().toISOString()
        };
    }
};

module.exports = {
    pool,
    query,
    transaction,
    testConnection,
    healthCheck
};