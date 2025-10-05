const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// Database connection
const { pool, healthCheck } = require('./config/database');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const userRoutes = require('./routes/users');
const accountRoutes = require('./routes/accounts');
const transactionRoutes = require('./routes/transactions');
const transferRoutes = require('./routes/transfers');
const budgetRoutes = require('./routes/budgets');
const reportRoutes = require('./routes/reports');
const receiptRoutes = require('./routes/receipts');
const ocrDirectRoutes = require('./routes/ocr-direct');
const storageCheckerRoutes = require('./routes/storage-checker');
const databaseSetupRoutes = require('./routes/database-setup');
const ocrTestRoutes = require('./routes/ocr-test');
const blobStorageRoutes = require('./routes/blob-storage');
const simpleOcrRoutes = require('./routes/simple-ocr');
const completeOcrRoutes = require('./routes/complete-ocr');
const mockOcrRoutes = require('./routes/mock-ocr');
const { authenticateToken } = require('./middleware/auth');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 5000;

// Security middleware - relaxed for development
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"], // Allow inline scripts for development
            styleSrc: ["'self'", "'unsafe-inline'"]   // Allow inline styles
        }
    }
}));

// CORS configuration - Allow multiple origins for development
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5000',
  process.env.https://proud-water-01e0f3800.2.azurestaticapps.net
];
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('CORS not allowed for this origin: ' + origin));
    }
  },
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_REQUESTS) || 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware
if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('combined'));
}

// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        // Simple database check
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        
        res.json({
            status: 'healthy',
            database: 'connected',
            ocr: 'enabled',
            timestamp: new Date().toISOString(),
            version: process.env.npm_package_version || '1.0.0'
        });
    } catch (error) {
        console.error('Health check failed:', error);
        res.status(503).json({
            status: 'unhealthy',
            database: 'error',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// API routes
const apiPrefix = process.env.API_PREFIX || '/api/v1';

// API info endpoint - must come BEFORE specific routes
app.get(`${apiPrefix}`, async (req, res) => {
    const dbHealth = await healthCheck();
    res.json({
        message: 'Personal Finance Tracker API v1 - OCR Enabled',
        version: '1.0.0',
        databaseConnected: dbHealth.healthy,
        ocrEnabled: true,
        endpoints: {
            auth: {
                login: 'POST /api/v1/auth/login'
            },
            receipts: {
                upload: 'POST /api/v1/receipts/upload',
                createTransaction: 'POST /api/v1/receipts/:id/create-transaction'
            },
            storage: {
                checkDatabase: 'GET /api/v1/storage/receipts/check-storage',
                checkBlob: 'GET /api/v1/storage/receipts/check-blob-storage',
                recent: 'GET /api/v1/storage/receipts/recent'
            }
        },
        testCredentials: {
            email: 'pvijaysanthosh@gmail.com',
            password: 'Asdf@123'
        }
    });
});

// Use the proper authenticateToken middleware from auth.js

app.use(`${apiPrefix}/auth`, authRoutes);
app.use(`${apiPrefix}/dashboard`, dashboardRoutes);  // Dashboard routes include auth middleware internally
app.use(`${apiPrefix}/users`, authenticateToken, userRoutes);
app.use(`${apiPrefix}/accounts`, authenticateToken, accountRoutes);
app.use(`${apiPrefix}/transactions`, authenticateToken, transactionRoutes);
app.use(`${apiPrefix}/transfers`, authenticateToken, transferRoutes);
app.use(`${apiPrefix}/budgets`, authenticateToken, budgetRoutes);
app.use(`${apiPrefix}/reports`, authenticateToken, reportRoutes);
app.use(`${apiPrefix}/receipts`, authenticateToken, receiptRoutes);
app.use(`${apiPrefix}/receipts`, ocrDirectRoutes); // Direct OCR without auth for testing
app.use(`${apiPrefix}/storage`, storageCheckerRoutes); // Storage verification endpoints
app.use(`${apiPrefix}/database-setup`, databaseSetupRoutes); // Database setup endpoints
app.use(`${apiPrefix}/ocr-test`, ocrTestRoutes); // OCR testing without database
app.use(`${apiPrefix}/blob-storage`, blobStorageRoutes); // Azure Blob Storage operations
app.use(`${apiPrefix}/simple-ocr`, simpleOcrRoutes); // Simple OCR text extraction
app.use(`${apiPrefix}/complete-ocr`, authenticateToken, completeOcrRoutes); // Complete OCR with blob storage
app.use(`${apiPrefix}/mock-ocr`, mockOcrRoutes); // Mock OCR without Azure integration (no auth for testing)

// Test HTML pages are served by their respective route files

// Serve test HTML pages
app.get('/test', (req, res) => {
    res.sendFile(__dirname + '/test_registration.html');
});

app.get('/test-login', (req, res) => {
    res.sendFile(__dirname + '/test_dashboard.html');
});

app.get('/test_dashboard.html', (req, res) => {
    res.sendFile(__dirname + '/test_dashboard.html');
});

app.get('/test_ocr_receipt.html', (req, res) => {
    res.sendFile(__dirname + '/test_ocr_receipt.html');
});

app.get('/simple_auth_test.html', (req, res) => {
    res.sendFile(__dirname + '/simple_auth_test.html');
});

app.get('/debug_login.html', (req, res) => {
    res.sendFile(__dirname + '/debug_login.html');
});

app.get('/ocr_only_test.html', (req, res) => {
    res.sendFile(__dirname + '/ocr_only_test.html');
});

app.get('/ocr_storage_checker.html', (req, res) => {
    res.sendFile(__dirname + '/ocr_storage_checker.html');
});

app.get('/working_ocr_test.html', (req, res) => {
    res.sendFile(__dirname + '/working_ocr_test.html');
});

app.get('/test-receipt', (req, res) => {
    res.sendFile(__dirname + '/../../test_receipt.html');
});

app.get('/blob-storage-test', (req, res) => {
    res.sendFile(__dirname + '/blob-storage-test.html');
});

app.get('/simple-ocr', (req, res) => {
    res.sendFile(__dirname + '/simple-ocr-test.html');
});

app.get('/quick-ocr-test', (req, res) => {
    res.sendFile(__dirname + '/quick-ocr-test.html');
});

app.get('/test-mock-ocr', (req, res) => {
    res.sendFile(__dirname + '/mock-ocr-test.html');
});

// Welcome endpoint
app.get('/', async (req, res) => {
    const dbHealth = await healthCheck();
    res.json({
        message: 'Personal Finance Tracker API - OCR Enabled',
        version: '1.0.0',
        databaseConnected: dbHealth.healthy,
        ocrEnabled: true,
        testPages: {
            ocrTest: '/test_ocr_receipt.html',
            authTest: '/simple_auth_test.html'
        },
        health: '/health'
    });
});

// Error handling middleware (must be last)
app.use(errorHandler);

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        message: 'Route not found',
        path: req.originalUrl
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Personal Finance Tracker API running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    console.log(`📖 API Base URL: http://localhost:${PORT}${apiPrefix}`);
    console.log(`🧾 OCR Test: http://localhost:${PORT}/test_ocr_receipt.html`);
    console.log(`🔐 Test credentials: pvijaysanthosh@gmail.com / Asdf@123`);
    console.log(`💾 Database: Azure PostgreSQL`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nSIGINT received, shutting down gracefully');
    await pool.end();
    console.log('Database connections closed');
    process.exit(0);
});
// Server starts automatically

module.exports = app;
