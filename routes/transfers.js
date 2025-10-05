const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Validation rules for transfer creation
const createTransferValidation = [
    body('fromAccountId')
        .isInt({ min: 1 })
        .withMessage('Valid source account ID is required'),
    body('toUserId')
        .isInt({ min: 1 })
        .withMessage('Valid recipient user ID is required'),
    body('amount')
        .isFloat({ min: 0.01 })
        .withMessage('Amount must be a positive number'),
    body('description')
        .trim()
        .isLength({ min: 1, max: 200 })
        .withMessage('Description must be between 1 and 200 characters'),
    body('transferDate')
        .optional()
        .isISO8601()
        .withMessage('Transfer date must be a valid ISO date'),
    body('notes')
        .optional()
        .isLength({ max: 500 })
        .withMessage('Notes must be 500 characters or less'),
    body('feeAmount')
        .optional()
        .isFloat({ min: 0 })
        .withMessage('Fee amount must be zero or positive')
];

// Get all user transfers with pagination and filtering
router.get('/', authenticateToken, asyncHandler(async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('SET search_path TO finance, public');
        await client.query(`SET app.current_user_id = '${req.user.user_id}'`);
        
        const userId = req.user.user_id;
        const {
            accountId, // Filter by specific account (either from or to)
            startDate,
            endDate,
            limit = 50,
            offset = 0
        } = req.query;

        // Build dynamic WHERE clause
        let whereConditions = [];
        let params = [userId];
        let paramCount = 1;

        // Ensure user can only see transfers involving their accounts
        whereConditions.push(`(fa.user_id = $${paramCount} OR ta.user_id = $${paramCount})`);

        if (accountId) {
            paramCount++;
            whereConditions.push(`(t.from_account_id = $${paramCount} OR t.to_account_id = $${paramCount})`);
            params.push(accountId);
        }

        if (startDate) {
            paramCount++;
            whereConditions.push(`t.transfer_date >= $${paramCount}`);
            params.push(startDate);
        }

        if (endDate) {
            paramCount++;
            whereConditions.push(`t.transfer_date <= $${paramCount}`);
            params.push(endDate);
        }

        const whereClause = whereConditions.length > 0 ? whereConditions.join(' AND ') : '1=1';

        // Main query to get transfers
        const transferQuery = `
            SELECT 
                t.transfer_id,
                t.amount,
                t.transfer_date,
                t.description,
                t.fee_amount,
                t.reference_number,
                t.created_date,
                t.notes,
                fa.account_id as from_account_id,
                fa.account_name as from_account_name,
                fat.type_name as from_account_type,
                ta.account_id as to_account_id,
                ta.account_name as to_account_name,
                tat.type_name as to_account_type,
                fu.user_id as from_user_id,
                fu.first_name as from_first_name,
                fu.last_name as from_last_name,
                tu.user_id as to_user_id,
                tu.first_name as to_first_name,
                tu.last_name as to_last_name
            FROM finance.transfers t
            JOIN finance.accounts fa ON t.from_account_id = fa.account_id
            JOIN finance.accounts ta ON t.to_account_id = ta.account_id
            JOIN finance.account_types fat ON fa.type_id = fat.type_id
            JOIN finance.account_types tat ON ta.type_id = tat.type_id
            JOIN finance.users fu ON fa.user_id = fu.user_id
            JOIN finance.users tu ON ta.user_id = tu.user_id
            WHERE ${whereClause}
            ORDER BY t.transfer_date DESC, t.created_date DESC
            LIMIT $${++paramCount} OFFSET $${++paramCount}
        `;
        
        params.push(limit, offset);

        // Get total count
        const countQuery = `
            SELECT COUNT(*) as total
            FROM finance.transfers t
            JOIN finance.accounts fa ON t.from_account_id = fa.account_id
            JOIN finance.accounts ta ON t.to_account_id = ta.account_id
            WHERE ${whereClause}
        `;
        
        const countParams = params.slice(0, -2); // Remove limit and offset

        const [transfersResult, countResult] = await Promise.all([
            client.query(transferQuery, params),
            client.query(countQuery, countParams)
        ]);

        const total = parseInt(countResult.rows[0].total);
        const totalPages = Math.ceil(total / limit);

        res.json({
            success: true,
            data: {
                transfers: transfersResult.rows.map(transfer => ({
                    id: transfer.transfer_id,
                    amount: parseFloat(transfer.amount),
                    feeAmount: parseFloat(transfer.fee_amount),
                    description: transfer.description,
                    date: transfer.transfer_date,
                    createdAt: transfer.created_date,
                    notes: transfer.notes,
                    referenceNumber: transfer.reference_number,
                    fromAccount: {
                        id: transfer.from_account_id,
                        name: transfer.from_account_name,
                        type: transfer.from_account_type,
                        user: {
                            id: transfer.from_user_id,
                            name: `${transfer.from_first_name} ${transfer.from_last_name}`
                        }
                    },
                    toAccount: {
                        id: transfer.to_account_id,
                        name: transfer.to_account_name,
                        type: transfer.to_account_type,
                        user: {
                            id: transfer.to_user_id,
                            name: `${transfer.to_first_name} ${transfer.to_last_name}`
                        }
                    },
                    // Indicate direction for current user
                    direction: transfer.from_user_id == userId ? 'outgoing' : 'incoming'
                })),
                pagination: {
                    currentPage: Math.floor(offset / limit) + 1,
                    totalPages,
                    totalRecords: total,
                    hasNextPage: offset + limit < total,
                    hasPreviousPage: offset > 0
                }
            }
        });

    } catch (error) {
        console.error('Transfers GET Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch transfers'
        });
    } finally {
        client.release();
    }
}));

// Create new transfer
router.post('/', authenticateToken, createTransferValidation, asyncHandler(async (req, res) => {
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
        await client.query('BEGIN');
        await client.query('SET search_path TO finance, public');
        await client.query(`SET app.current_user_id = '${req.user.user_id}'`);
        
        const userId = req.user.user_id;
        const {
            fromAccountId,
            toUserId,
            amount,
            description,
            transferDate = new Date().toISOString().split('T')[0],
            notes,
            feeAmount = 0
        } = req.body;

        // Validate not transferring to same user
        if (userId === toUserId) {
            return res.status(400).json({
                success: false,
                message: 'Cannot transfer money to yourself'
            });
        }

        // Verify source account belongs to user and has sufficient balance
        const fromAccountResult = await client.query(`
            SELECT account_id, account_name, current_balance, user_id
            FROM finance.accounts 
            WHERE account_id = $1
        `, [fromAccountId]);

        console.log('🔍 Looking for recipient accounts for user ID:', toUserId);
        
        // Find recipient's primary account (any account for now)
        const toAccountResult = await client.query(`
            SELECT account_id, account_name, user_id, is_active
            FROM finance.accounts 
            WHERE user_id = $1
            ORDER BY account_id ASC
            LIMIT 1
        `, [toUserId]);
        
        console.log('🔍 Recipient account query result:', toAccountResult.rows);
        
        // Also check all accounts for this user (for debugging)
        const allAccountsResult = await client.query(`
            SELECT account_id, account_name, user_id, is_active
            FROM finance.accounts 
            WHERE user_id = $1
        `, [toUserId]);
        
        console.log('🔍 All accounts for recipient user:', allAccountsResult.rows);

        if (fromAccountResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Source account not found'
            });
        }

        if (toAccountResult.rows.length === 0) {
            console.log('❌ No active accounts found for recipient user ID:', toUserId);
            console.log('❌ All accounts for recipient:', allAccountsResult.rows);
            return res.status(404).json({
                success: false,
                message: 'Recipient has no active accounts'
            });
        }

        const fromAccount = fromAccountResult.rows[0];
        const toAccount = toAccountResult.rows[0];
        const toAccountId = toAccount.account_id;
        
        console.log('✅ Found recipient account:', {
            id: toAccount.account_id,
            name: toAccount.account_name,
            user_id: toAccount.user_id
        });
        
        // Check if user owns the source account
        if (fromAccount.user_id !== userId) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to transfer from this account'
            });
        }

        // Check sufficient balance (including fee)
        const totalDeduction = parseFloat(amount) + parseFloat(feeAmount);
        if (fromAccount.current_balance < totalDeduction) {
            return res.status(400).json({
                success: false,
                message: `Insufficient balance. Available: $${fromAccount.current_balance}, Required: $${totalDeduction}`
            });
        }

        // Additional validation: ensure accounts are different
        if (fromAccountId === toAccountId) {
            return res.status(400).json({
                success: false,
                message: 'Source and destination accounts are the same'
            });
        }

        // Create the transfer
        const insertResult = await client.query(`
            INSERT INTO finance.transfers (
                from_account_id, 
                to_account_id, 
                amount, 
                transfer_date, 
                description, 
                fee_amount,
                notes
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING transfer_id, amount, fee_amount, description, 
                      transfer_date, created_date, notes, reference_number
        `, [fromAccountId, toAccountId, amount, transferDate, description, feeAmount, notes]);

        const newTransfer = insertResult.rows[0];

        // Commit the transaction (triggers will automatically update account balances)
        await client.query('COMMIT');

        // Get updated account balances for response
        const [fromBalanceResult, toBalanceResult] = await Promise.all([
            client.query('SELECT current_balance FROM finance.accounts WHERE account_id = $1', [fromAccountId]),
            client.query('SELECT current_balance FROM finance.accounts WHERE account_id = $1', [toAccountId])
        ]);

        res.status(201).json({
            success: true,
            message: 'Transfer created successfully',
            data: {
                transferId: newTransfer.transfer_id,
                amount: parseFloat(newTransfer.amount),
                feeAmount: parseFloat(newTransfer.fee_amount),
                description: newTransfer.description,
                date: newTransfer.transfer_date,
                createdAt: newTransfer.created_date,
                notes: newTransfer.notes,
                referenceNumber: newTransfer.reference_number,
                fromAccount: {
                    id: fromAccountId,
                    name: fromAccount.account_name,
                    newBalance: parseFloat(fromBalanceResult.rows[0].current_balance)
                },
                toAccount: {
                    id: toAccountId,
                    name: toAccount.account_name,
                    newBalance: parseFloat(toBalanceResult.rows[0].current_balance),
                    owner: `${toAccount.first_name} ${toAccount.last_name}`,
                    ownerEmail: toAccount.email
                }
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Transfer POST Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create transfer'
        });
    } finally {
        client.release();
    }
}));

// Get transfer by ID
router.get('/:transferId', authenticateToken, [
    param('transferId').isInt({ min: 1 }).withMessage('Valid transfer ID is required')
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
        const transferId = req.params.transferId;

        const result = await client.query(`
            SELECT 
                t.transfer_id,
                t.amount,
                t.transfer_date,
                t.description,
                t.fee_amount,
                t.reference_number,
                t.created_date,
                t.notes,
                fa.account_id as from_account_id,
                fa.account_name as from_account_name,
                fa.current_balance as from_account_balance,
                fat.type_name as from_account_type,
                ta.account_id as to_account_id,
                ta.account_name as to_account_name,
                ta.current_balance as to_account_balance,
                tat.type_name as to_account_type,
                fu.user_id as from_user_id,
                fu.first_name as from_first_name,
                fu.last_name as from_last_name,
                fu.email as from_user_email,
                tu.user_id as to_user_id,
                tu.first_name as to_first_name,
                tu.last_name as to_last_name,
                tu.email as to_user_email
            FROM finance.transfers t
            JOIN finance.accounts fa ON t.from_account_id = fa.account_id
            JOIN finance.accounts ta ON t.to_account_id = ta.account_id
            JOIN finance.account_types fat ON fa.type_id = fat.type_id
            JOIN finance.account_types tat ON ta.type_id = tat.type_id
            JOIN finance.users fu ON fa.user_id = fu.user_id
            JOIN finance.users tu ON ta.user_id = tu.user_id
            WHERE t.transfer_id = $1 
              AND (fa.user_id = $2 OR ta.user_id = $2)
        `, [transferId, userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Transfer not found or access denied'
            });
        }

        const transfer = result.rows[0];

        res.json({
            success: true,
            data: {
                id: transfer.transfer_id,
                amount: parseFloat(transfer.amount),
                feeAmount: parseFloat(transfer.fee_amount),
                description: transfer.description,
                date: transfer.transfer_date,
                createdAt: transfer.created_date,
                notes: transfer.notes,
                referenceNumber: transfer.reference_number,
                fromAccount: {
                    id: transfer.from_account_id,
                    name: transfer.from_account_name,
                    type: transfer.from_account_type,
                    currentBalance: parseFloat(transfer.from_account_balance),
                    user: {
                        id: transfer.from_user_id,
                        name: `${transfer.from_first_name} ${transfer.from_last_name}`,
                        email: transfer.from_user_email
                    }
                },
                toAccount: {
                    id: transfer.to_account_id,
                    name: transfer.to_account_name,
                    type: transfer.to_account_type,
                    currentBalance: parseFloat(transfer.to_account_balance),
                    user: {
                        id: transfer.to_user_id,
                        name: `${transfer.to_first_name} ${transfer.to_last_name}`,
                        email: transfer.to_user_email
                    }
                },
                direction: transfer.from_user_id == userId ? 'outgoing' : 'incoming',
                canModify: transfer.from_user_id == userId // Only sender can modify
            }
        });

    } catch (error) {
        console.error('Transfer GET by ID Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch transfer details'
        });
    } finally {
        client.release();
    }
}));

module.exports = router;