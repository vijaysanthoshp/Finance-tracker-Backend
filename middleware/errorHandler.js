// Global error handling middleware
const errorHandler = (err, req, res, next) => {
    console.error('Error Stack:', err.stack);

    // Default error
    let error = { ...err };
    error.message = err.message;

    // PostgreSQL specific errors
    if (err.code) {
        switch (err.code) {
            case '23505': // Unique violation
                error.message = 'Duplicate entry: This record already exists';
                error.statusCode = 400;
                break;
            case '23503': // Foreign key violation
                error.message = 'Invalid reference: Referenced record not found';
                error.statusCode = 400;
                break;
            case '23514': // Check constraint violation
                error.message = 'Invalid data: Data does not meet requirements';
                error.statusCode = 400;
                break;
            case '23502': // Not null violation
                error.message = 'Missing required field';
                error.statusCode = 400;
                break;
            case 'P0001': // Raised exception (custom business logic)
                error.message = err.message;
                error.statusCode = 400;
                break;
            case '08003': // Connection does not exist
                error.message = 'Database connection error';
                error.statusCode = 503;
                break;
            case '08006': // Connection failure
                error.message = 'Database connection failure';
                error.statusCode = 503;
                break;
            case '42P01': // Undefined table
                error.message = 'Database configuration error';
                error.statusCode = 500;
                break;
            default:
                error.message = 'Database operation failed';
                error.statusCode = 500;
        }
    }

    // Mongoose/MongoDB errors (if ever used alongside PostgreSQL)
    if (err.name === 'CastError') {
        error.message = 'Invalid ID format';
        error.statusCode = 400;
    }

    // JWT errors
    if (err.name === 'JsonWebTokenError') {
        error.message = 'Invalid token';
        error.statusCode = 401;
    }

    if (err.name === 'TokenExpiredError') {
        error.message = 'Token expired';
        error.statusCode = 401;
    }

    // Validation errors
    if (err.name === 'ValidationError') {
        const messages = Object.values(err.errors).map(val => val.message);
        error.message = messages.join(', ');
        error.statusCode = 400;
    }

    // Joi validation errors
    if (err.isJoi) {
        error.message = err.details.map(detail => detail.message).join(', ');
        error.statusCode = 400;
    }

    // Express validator errors
    if (err.array && typeof err.array === 'function') {
        const errors = err.array();
        error.message = errors.map(e => e.msg).join(', ');
        error.statusCode = 400;
    }

    // Rate limiting errors
    if (err.status === 429) {
        error.message = 'Too many requests, please try again later';
        error.statusCode = 429;
    }

    // File upload errors
    if (err.code === 'LIMIT_FILE_SIZE') {
        error.message = 'File size too large';
        error.statusCode = 400;
    }

    // Default to 500 server error
    const statusCode = error.statusCode || 500;
    const message = error.message || 'Internal Server Error';

    // Log error details for debugging
    console.error(`Error ${statusCode}: ${message}`);
    
    // Don't leak error details in production
    const response = {
        success: false,
        message: message
    };

    // Add error details in development
    if (process.env.NODE_ENV === 'development') {
        response.error = {
            stack: err.stack,
            code: err.code,
            name: err.name
        };
    }

    // Add request details for debugging
    if (process.env.NODE_ENV === 'development') {
        response.request = {
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: req.body,
            params: req.params,
            query: req.query
        };
    }

    res.status(statusCode).json(response);
};

// Async error wrapper to catch async errors
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// Custom error class
class AppError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
        this.isOperational = true;

        Error.captureStackTrace(this, this.constructor);
    }
}

module.exports = {
    errorHandler,
    asyncHandler,
    AppError
};