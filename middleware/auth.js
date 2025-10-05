const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

// JWT Authentication middleware
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({
            success: false,
            message: 'Access token required'
        });
    }

    const client = await pool.connect();

    try {
        // Verify JWT token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Set schema and check if user still exists in database
        await client.query('SET search_path TO finance, public');
        
        const result = await client.query(
            'SELECT user_id, username, email, first_name, last_name, date_created, is_active FROM finance.users WHERE user_id = $1 AND is_active = true',
            [decoded.user_id]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Invalid token - user not found'
            });
        }

        const user = result.rows[0];

        // Add user info to request object
        req.user = {
            user_id: user.user_id,
            username: user.username,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            fullName: `${user.first_name} ${user.last_name}`.trim(),
            createdAt: user.date_created,
            isActive: user.is_active
        };

        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({
                success: false,
                message: 'Invalid token'
            });
        } else if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                success: false,
                message: 'Token expired'
            });
        } else {
            console.error('Authentication error:', error);
            return res.status(500).json({
                success: false,
                message: 'Authentication failed'
            });
        }
    } finally {
        client.release();
    }
};

// Optional authentication middleware (doesn't fail if no token)
const optionalAuth = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        req.user = null;
        return next();
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        const result = await query(
            'SELECT user_id, email, full_name, created_at FROM users WHERE user_id = $1',
            [decoded.userId]
        );

        if (result.rows.length > 0) {
            req.user = {
                userId: decoded.userId,
                email: decoded.email,
                fullName: result.rows[0].full_name,
                createdAt: result.rows[0].created_at
            };
        } else {
            req.user = null;
        }
    } catch (error) {
        req.user = null;
    }

    next();
};

// Generate JWT token
const generateToken = (user) => {
    const payload = {
        user_id: user.user_id,
        email: user.email
    };

    return jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRE || '7d'
    });
};

// Refresh token validation
const validateRefreshToken = async (refreshToken) => {
    try {
        const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
        
        const result = await query(
            'SELECT user_id, email, full_name FROM users WHERE user_id = $1',
            [decoded.user_id]
        );

        return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error) {
        return null;
    }
};

module.exports = {
    authenticateToken,
    optionalAuth,
    generateToken,
    validateRefreshToken
};