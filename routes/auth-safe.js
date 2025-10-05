const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { safeQuery, isDatabaseConnected } = require('../config/database-safe');

const router = express.Router();

/**
 * POST /auth/login
 * User login with fallback mode support
 */
router.post('/login', 
    [
        body('email').isEmail().withMessage('Valid email is required'),
        body('password').isLength({ min: 1 }).withMessage('Password is required')
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({
                    success: false,
                    message: 'Validation errors',
                    errors: errors.array()
                });
            }

            const { email, password } = req.body;
            console.log(`🔐 Login attempt: ${email}`);

            // If database is not connected, use fallback authentication
            if (!isDatabaseConnected()) {
                console.log('⚠️  Database unavailable - using fallback authentication');
                
                // Hardcoded test credentials for OCR testing
                if ((email === 'pvijaysanthosh@gmail.com' && password === 'Asdf@123') ||
                    (email === 'test@example.com' && password === 'password123')) {
                    
                    const token = jwt.sign(
                        { 
                            userId: 1, 
                            email: email,
                            username: email.split('@')[0]
                        },
                        process.env.JWT_SECRET || 'fallback-secret',
                        { expiresIn: '24h' }
                    );

                    return res.json({
                        success: true,
                        message: 'Login successful (fallback mode)',
                        data: {
                            token: token,
                            user: {
                                user_id: 1,
                                username: email.split('@')[0],
                                email: email,
                                created_at: new Date().toISOString()
                            }
                        }
                    });
                } else {
                    return res.status(401).json({
                        success: false,
                        message: 'Invalid credentials. Try: pvijaysanthosh@gmail.com / Asdf@123'
                    });
                }
            }

            // Database is available - use real authentication
            try {
                const result = await safeQuery(
                    'SELECT user_id, username, email, password_hash, date_created FROM finance.users WHERE email = $1',
                    [email]
                );

                if (result.rows.length === 0) {
                    return res.status(401).json({
                        success: false,
                        message: 'Invalid email or password'
                    });
                }

                const user = result.rows[0];
                const validPassword = await bcrypt.compare(password, user.password_hash);

                if (!validPassword) {
                    return res.status(401).json({
                        success: false,
                        message: 'Invalid email or password'
                    });
                }

                // Generate JWT token
                const token = jwt.sign(
                    { 
                        userId: user.user_id,
                        email: user.email,
                        username: user.username
                    },
                    process.env.JWT_SECRET,
                    { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
                );

                console.log(`✅ Login successful for user: ${user.username}`);

                res.json({
                    success: true,
                    message: 'Login successful',
                    data: {
                        token: token,
                        user: {
                            user_id: user.user_id,
                            username: user.username,
                            email: user.email,
                            created_at: user.date_created
                        }
                    }
                });

            } catch (dbError) {
                console.error('Database query failed:', dbError);
                return res.status(500).json({
                    success: false,
                    message: 'Database error during authentication'
                });
            }

        } catch (error) {
            console.error('Login error:', error);
            res.status(500).json({
                success: false,
                message: 'Login failed',
                error: error.message
            });
        }
    }
);

/**
 * POST /auth/register
 * User registration with fallback mode support
 */
router.post('/register',
    [
        body('username').isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
        body('email').isEmail().withMessage('Valid email is required'),
        body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({
                    success: false,
                    message: 'Validation errors',
                    errors: errors.array()
                });
            }

            const { username, email, password } = req.body;
            console.log(`📝 Registration attempt: ${email}`);

            // If database is not connected, return info message
            if (!isDatabaseConnected()) {
                return res.status(503).json({
                    success: false,
                    message: 'Registration requires database connection. Use test credentials: pvijaysanthosh@gmail.com / Asdf@123'
                });
            }

            // Database is available - proceed with real registration
            try {
                // Check if user already exists
                const existingUser = await safeQuery(
                    'SELECT user_id FROM finance.users WHERE email = $1 OR username = $2',
                    [email, username]
                );

                if (existingUser.rows.length > 0) {
                    return res.status(400).json({
                        success: false,
                        message: 'User with this email or username already exists'
                    });
                }

                // Hash password
                const saltRounds = 10;
                const hashedPassword = await bcrypt.hash(password, saltRounds);

                // Insert new user (include required first_name and last_name)
                const result = await safeQuery(
                    'INSERT INTO finance.users (username, email, password_hash, first_name, last_name) VALUES ($1, $2, $3, $4, $5) RETURNING user_id, username, email, date_created',
                    [username, email, hashedPassword, 'User', 'Name']
                );

                const newUser = result.rows[0];
                console.log(`✅ User registered successfully: ${newUser.username}`);

                res.status(201).json({
                    success: true,
                    message: 'User registered successfully',
                    data: {
                        user: {
                            user_id: newUser.user_id,
                            username: newUser.username,
                            email: newUser.email,
                            created_at: newUser.date_created
                        }
                    }
                });

            } catch (dbError) {
                console.error('Database error during registration:', dbError);
                return res.status(500).json({
                    success: false,
                    message: 'Database error during registration'
                });
            }

        } catch (error) {
            console.error('Registration error:', error);
            res.status(500).json({
                success: false,
                message: 'Registration failed',
                error: error.message
            });
        }
    }
);

module.exports = router;