const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Validation rules for transaction creation
const createTransactionValidation = [
    body('accountId')
        .isInt({ min: 1 })
        .withMessage('Valid account ID is required'),
    body('categoryId')
        .isInt({ min: 1 })
        .withMessage('Valid category ID is required'),
    body('transactionType')
        .isIn(['INCOME', 'EXPENSE'])
        .withMessage('Transaction type must be INCOME or EXPENSE'),
    body('amount')
        .isFloat({ min: 0.01 })
        .withMessage('Amount must be a positive number'),
    body('description')
        .trim()
        .isLength({ min: 1, max: 200 })
        .withMessage('Description must be between 1 and 200 characters'),
    body('transactionDate')
        .optional()
        .isISO8601()
        .withMessage('Transaction date must be a valid ISO date'),
    body('notes')
        .optional()
        .isLength({ max: 500 })
        .withMessage('Notes must be 500 characters or less')
];

// Get all user transactions with pagination
router.get('/', authenticateToken, asyncHandler(async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('SET search_path TO finance, public');
        await client.query(`SET app.current_user_id = '${req.user.user_id}'`);
        
        const userId = req.user.user_id;
        const {
            accountId,
            categoryId,
            transactionType,
            startDate,
            endDate,
            page = 1,
            limit = 20
        } = req.query;

        // Build base query
        let whereConditions = ['a.user_id = $1'];
        let params = [userId];
        let paramCount = 1;

        // Add filters
        if (accountId) {
            whereConditions.push(`t.account_id = $${++paramCount}`);
            params.push(accountId);
        }
        
        if (categoryId) {
            whereConditions.push(`t.category_id = $${++paramCount}`);
            params.push(categoryId);
        }
        
        if (transactionType) {
            whereConditions.push(`t.transaction_type = $${++paramCount}`);
            params.push(transactionType);
        }
        
        if (startDate) {
            whereConditions.push(`t.transaction_date >= $${++paramCount}`);
            params.push(startDate);
        }
        
        if (endDate) {
            whereConditions.push(`t.transaction_date <= $${++paramCount}`);
            params.push(endDate);
        }

        const whereClause = whereConditions.join(' AND ');
        
        // Get transactions with pagination
        const offset = (page - 1) * limit;
        const transactionQuery = `
            SELECT 
                t.transaction_id,
                t.transaction_type,
                t.amount,
                t.description,
                t.transaction_date,
                t.created_date,
                t.notes,
                a.account_id,
                a.account_name,
                at.type_name as account_type,
                c.category_id,
                c.category_name,
                c.category_type
            FROM finance.transactions t
            JOIN finance.accounts a ON t.account_id = a.account_id
            JOIN finance.account_types at ON a.type_id = at.type_id
            JOIN finance.categories c ON t.category_id = c.category_id
            WHERE ${whereClause}
            ORDER BY t.transaction_date DESC, t.created_date DESC
            LIMIT $${++paramCount} OFFSET $${++paramCount}
        `;
        
        params.push(limit, offset);

        // Get total count
        const countQuery = `
            SELECT COUNT(*) as total
            FROM finance.transactions t
            JOIN finance.accounts a ON t.account_id = a.account_id
            WHERE ${whereClause}
        `;
        
        const countParams = params.slice(0, -2); // Remove limit and offset

        const [transactionsResult, countResult] = await Promise.all([
            client.query(transactionQuery, params),
            client.query(countQuery, countParams)
        ]);

        const total = parseInt(countResult.rows[0].total);
        const totalPages = Math.ceil(total / limit);

        res.json({
            success: true,
            data: {
                transactions: transactionsResult.rows.map(transaction => ({
                    id: transaction.transaction_id,
                    type: transaction.transaction_type,
                    amount: parseFloat(transaction.amount),
                    description: transaction.description,
                    date: transaction.transaction_date,
                    createdAt: transaction.created_date,
                    notes: transaction.notes,
                    account: {
                        id: transaction.account_id,
                        name: transaction.account_name,
                        type: transaction.account_type
                    },
                    category: {
                        id: transaction.category_id,
                        name: transaction.category_name,
                        type: transaction.category_type
                    }
                })),
                pagination: {
                    currentPage: parseInt(page),
                    totalPages,
                    totalRecords: total,
                    limit: parseInt(limit),
                    hasNextPage: page < totalPages,
                    hasPreviousPage: page > 1
                }
            }
        });

    } catch (error) {
        console.error('Get Transactions API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load transactions'
        });
    } finally {
        client.release();
    }
}));

// Create new transaction
router.post('/', authenticateToken, createTransactionValidation, asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            message: 'Validation errors',
            errors: errors.array()
        });
    }

    const client = await pool.connect();
    
    try {
        await client.query('SET search_path TO finance, public');
        await client.query(`SET app.current_user_id = '${req.user.user_id}'`);
        
        const userId = req.user.user_id;
        const {
            accountId,
            categoryId,
            transactionType,
            amount,
            description,
            transactionDate = new Date().toISOString().split('T')[0],
            notes
        } = req.body;

        // Verify account belongs to user
        const accountResult = await client.query(`
            SELECT account_id, account_name, current_balance 
            FROM finance.accounts 
            WHERE account_id = $1 AND user_id = $2
        `, [accountId, userId]);

        if (accountResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Account not found or does not belong to user'
            });
        }

        // Verify category exists and is accessible to user
        const categoryResult = await client.query(`
            SELECT category_id, category_name, category_type 
            FROM finance.categories 
            WHERE category_id = $1 AND (user_id = $2 OR is_system = true)
        `, [categoryId, userId]);

        if (categoryResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Category not found or not accessible'
            });
        }

        // Create the transaction
        const insertResult = await client.query(`
            INSERT INTO finance.transactions (
                account_id, 
                category_id, 
                transaction_type, 
                amount, 
                description, 
                transaction_date, 
                notes
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING transaction_id, transaction_type, amount, description, 
                      transaction_date, created_date, notes
        `, [accountId, categoryId, transactionType, amount, description, transactionDate, notes]);

        const newTransaction = insertResult.rows[0];
        const account = accountResult.rows[0];
        const category = categoryResult.rows[0];

        res.status(201).json({
            success: true,
            message: 'Transaction created successfully',
            data: {
                id: newTransaction.transaction_id,
                type: newTransaction.transaction_type,
                amount: parseFloat(newTransaction.amount),
                description: newTransaction.description,
                date: newTransaction.transaction_date,
                createdAt: newTransaction.created_date,
                notes: newTransaction.notes,
                account: {
                    id: account.account_id,
                    name: account.account_name,
                    previousBalance: parseFloat(account.current_balance)
                },
                category: {
                    id: category.category_id,
                    name: category.category_name,
                    type: category.category_type
                }
            }
        });

    } catch (error) {
        console.error('Create Transaction API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create transaction'
        });
    } finally {
        client.release();
    }
}));

// Get all categories available to the user (must be authenticated)
router.get('/categories', authenticateToken, asyncHandler(async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('SET search_path TO finance, public');
        await client.query(`SET app.current_user_id = '${req.user.user_id}'`);
        
        const userId = req.user.user_id;
        
        const result = await client.query(`
            SELECT 
                category_id as id,
                category_name as name,
                category_type as type,
                is_system,
                user_id
            FROM finance.categories 
            WHERE user_id = $1 OR is_system = true
            ORDER BY is_system DESC, category_name ASC
        `, [userId]);

        res.json({
            success: true,
            data: result.rows
        });
        
    } catch (error) {
        console.error('Get Categories API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load categories'
        });
    } finally {
        client.release();
    }
}));

// Get transaction by ID
router.get('/:id', [
    param('id').isInt({ min: 1 }).withMessage('Valid transaction ID is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            message: 'Validation errors',
            errors: errors.array()
        });
    }

    const client = await pool.connect();
    
    try {
        await client.query('SET search_path TO finance, public');
        await client.query(`SET app.current_user_id = '${req.user.user_id}'`);
        
        const userId = req.user.user_id;
        const transactionId = req.params.id;

        const result = await client.query(`
            SELECT 
                t.transaction_id,
                t.transaction_type,
                t.amount,
                t.description,
                t.transaction_date,
                t.created_date,
                t.modified_date,
                t.notes,
                t.reference_number,
                a.account_id,
                a.account_name,
                at.type_name as account_type,
                c.category_id,
                c.category_name,
                c.category_type
            FROM finance.transactions t
            JOIN finance.accounts a ON t.account_id = a.account_id
            JOIN finance.account_types at ON a.type_id = at.type_id
            JOIN finance.categories c ON t.category_id = c.category_id
            WHERE t.transaction_id = $1 AND a.user_id = $2
        `, [transactionId, userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Transaction not found or does not belong to user'
            });
        }

        const transaction = result.rows[0];

        res.json({
            success: true,
            data: {
                id: transaction.transaction_id,
                type: transaction.transaction_type,
                amount: parseFloat(transaction.amount),
                description: transaction.description,
                date: transaction.transaction_date,
                createdAt: transaction.created_date,
                modifiedAt: transaction.modified_date,
                notes: transaction.notes,
                referenceNumber: transaction.reference_number,
                account: {
                    id: transaction.account_id,
                    name: transaction.account_name,
                    type: transaction.account_type
                },
                category: {
                    id: transaction.category_id,
                    name: transaction.category_name,
                    type: transaction.category_type
                }
            }
        });

    } catch (error) {
        console.error('Get Transaction API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load transaction details'
        });
    } finally {
        client.release();
    }
}));

module.exports = router;