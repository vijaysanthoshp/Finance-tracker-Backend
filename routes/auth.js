const express = require('express');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const UserModel = require('../models/User');
const { generateToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

// Validation rules
const registerValidation = [
    body('username')
        .trim()
        .isLength({ min: 3, max: 50 })
        .withMessage('Username must be between 3 and 50 characters')
        .matches(/^[a-zA-Z0-9_]+$/)
        .withMessage('Username can only contain letters, numbers, and underscores'),
    body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Please provide a valid email'),
    body('password')
        .isLength({ min: 6 })
        .withMessage('Password must be at least 6 characters long')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),
    body('full_name')
        .trim()
        .isLength({ min: 2, max: 100 })
        .withMessage('Full name must be between 2 and 100 characters'),
    body('phone_number')
        .optional()
        .isMobilePhone()
        .withMessage('Please provide a valid phone number')
];

const loginValidation = [
    body('usernameOrEmail')
        .notEmpty()
        .withMessage('Username or email is required'),
    body('password')
        .notEmpty()
        .withMessage('Password is required')
];

// Register new user
router.post('/register', registerValidation, asyncHandler(async (req, res) => {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            message: 'Validation errors',
            errors: errors.array()
        });
    }

    const { username, email, password, full_name, phone_number } = req.body;

    try {
        // Create user using our model - this will automatically insert into your database!
        const result = await UserModel.createUser({
            username,
            email,
            password,
            full_name,
            phone_number
        });

        // Generate JWT token
        const token = generateToken(result.user);

        res.status(201).json({
            success: true,
            message: result.message,
            data: {
                user: {
                    id: result.user.id,
                    username: result.user.username,
                    email: result.user.email,
                    fullName: result.user.fullName,
                    firstName: result.user.firstName,
                    lastName: result.user.lastName,
                    createdAt: result.user.createdAt,
                    isActive: result.user.isActive
                },
                token
            }
        });

    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message || 'Registration failed'
        });
    }
}));

// Login user
router.post('/login', loginValidation, asyncHandler(async (req, res) => {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            message: 'Validation errors',
            errors: errors.array()
        });
    }

    const { usernameOrEmail, password } = req.body;

    try {
        // Find user by username or email
        const user = await UserModel.findUser(usernameOrEmail);

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Validate password
        const isValidPassword = await UserModel.validatePassword(password, user.password_hash);

        if (!isValidPassword) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Generate JWT token
        const token = generateToken({
            user_id: user.user_id,
            username: user.username,
            email: user.email
        });

        // Update last_login timestamp
        await UserModel.updateLastLogin(user.user_id);

        res.json({
            success: true,
            message: 'Login successful',
            data: {
                user: {
                    id: user.user_id,
                    username: user.username,
                    email: user.email,
                    fullName: `${user.first_name} ${user.last_name}`.trim(),
                    firstName: user.first_name,
                    lastName: user.last_name,
                    createdAt: user.date_created,
                    lastLogin: user.last_login,
                    isActive: user.is_active
                },
                token
            }
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message || 'Login failed'
        });
    }
}));

// Refresh token
router.post('/refresh', asyncHandler(async (req, res) => {
    const { token } = req.body;

    if (!token) {
        return res.status(401).json({
            success: false,
            message: 'Refresh token required'
        });
    }

    try {
        // Verify the token (it might be expired, but we can still decode it)
        const decoded = jwt.decode(token);
        
        if (!decoded) {
            return res.status(401).json({
                success: false,
                message: 'Invalid token'
            });
        }

        // Get fresh user data
        const result = await query(
            'SELECT user_id, email, full_name, created_at FROM users WHERE user_id = $1',
            [decoded.userId]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'User not found'
            });
        }

        const user = result.rows[0];
        const newToken = generateToken(user);

        res.json({
            success: true,
            message: 'Token refreshed successfully',
            data: {
                user: {
                    id: user.user_id,
                    email: user.email,
                    fullName: user.full_name,
                    createdAt: user.created_at
                },
                token: newToken
            }
        });
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: 'Invalid refresh token'
        });
    }
}));

// Verify token
router.get('/verify', asyncHandler(async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({
            success: false,
            message: 'No token provided'
        });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        const result = await query(
            'SELECT user_id, email, full_name, created_at FROM users WHERE user_id = $1',
            [decoded.userId]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Invalid token'
            });
        }

        const user = result.rows[0];

        res.json({
            success: true,
            message: 'Token is valid',
            data: {
                user: {
                    id: user.user_id,
                    email: user.email,
                    fullName: user.full_name,
                    createdAt: user.created_at
                }
            }
        });
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: 'Invalid token'
        });
    }
}));

module.exports = router;