const express = require('express');
const { body, validationResult } = require('express-validator');
const { query } = require('../config/database');
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticateToken } = require('../middleware/auth');
const { pool } = require('../config/database');

const router = express.Router();

// Get all users (for transfer recipient selection)
router.get('/', authenticateToken, asyncHandler(async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('SET search_path TO finance, public');
        
        const result = await client.query(`
            SELECT 
                u.user_id,
                u.email,
                u.first_name,
                u.last_name,
                u.date_created
            FROM users u
            WHERE u.is_active = true
            ORDER BY u.first_name, u.last_name
        `);

        res.json({
            success: true,
            data: result.rows.map(user => ({
                user_id: user.user_id,
                email: user.email,
                first_name: user.first_name,
                last_name: user.last_name,
                date_created: user.date_created
            }))
        });
    } finally {
        client.release();
    }
}));

// Get accounts for a specific user (for transfer destination selection)
router.get('/:userId/accounts', authenticateToken, asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const client = await pool.connect();
    
    try {
        await client.query('SET search_path TO finance, public');
        
        const result = await client.query(`
            SELECT 
                a.account_id,
                a.account_name,
                a.current_balance,
                at.type_name as account_type
            FROM accounts a
            JOIN account_types at ON a.type_id = at.type_id
            WHERE a.user_id = $1 AND a.is_active = true
            ORDER BY a.account_name
        `, [userId]);

        res.json({
            success: true,
            data: result.rows.map(account => ({
                account_id: account.account_id,
                account_name: account.account_name,
                current_balance: parseFloat(account.current_balance),
                account_type: account.account_type
            }))
        });
    } finally {
        client.release();
    }
}));

// Get user profile
router.get('/profile', asyncHandler(async (req, res) => {
    const userId = req.user.userId;

    const result = await query(`
        SELECT 
            u.user_id,
            u.email,
            u.full_name,
            u.date_of_birth,
            u.created_at,
            COUNT(a.account_id) as account_count,
            COALESCE(SUM(a.balance), 0) as total_balance
        FROM users u
        LEFT JOIN accounts a ON u.user_id = a.user_id
        WHERE u.user_id = $1
        GROUP BY u.user_id, u.email, u.full_name, u.date_of_birth, u.created_at
    `, [userId]);

    if (result.rows.length === 0) {
        return res.status(404).json({
            success: false,
            message: 'User not found'
        });
    }

    const user = result.rows[0];

    res.json({
        success: true,
        data: {
            id: user.user_id,
            email: user.email,
            fullName: user.full_name,
            dateOfBirth: user.date_of_birth,
            createdAt: user.created_at,
            accountCount: parseInt(user.account_count),
            totalBalance: parseFloat(user.total_balance)
        }
    });
}));

// Update user profile
router.put('/profile', [
    body('fullName')
        .optional()
        .trim()
        .isLength({ min: 2, max: 100 })
        .withMessage('Full name must be between 2 and 100 characters'),
    body('dateOfBirth')
        .optional()
        .isDate()
        .withMessage('Please provide a valid date of birth')
], asyncHandler(async (req, res) => {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            message: 'Validation errors',
            errors: errors.array()
        });
    }

    const userId = req.user.userId;
    const { fullName, dateOfBirth } = req.body;

    // Build update query dynamically
    const updateFields = [];
    const updateValues = [];
    let paramCount = 0;

    if (fullName !== undefined) {
        updateFields.push(`full_name = $${++paramCount}`);
        updateValues.push(fullName);
    }

    if (dateOfBirth !== undefined) {
        updateFields.push(`date_of_birth = $${++paramCount}`);
        updateValues.push(dateOfBirth);
    }

    if (updateFields.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'No valid fields to update'
        });
    }

    // Add updated_at field
    updateFields.push(`updated_at = NOW()`);
    
    // Add user_id for WHERE clause
    updateValues.push(userId);
    
    const updateQuery = `
        UPDATE users 
        SET ${updateFields.join(', ')}
        WHERE user_id = $${updateValues.length}
        RETURNING user_id, email, full_name, date_of_birth, updated_at
    `;

    const result = await query(updateQuery, updateValues);

    res.json({
        success: true,
        message: 'Profile updated successfully',
        data: {
            id: result.rows[0].user_id,
            email: result.rows[0].email,
            fullName: result.rows[0].full_name,
            dateOfBirth: result.rows[0].date_of_birth,
            updatedAt: result.rows[0].updated_at
        }
    });
}));

// Get user statistics
router.get('/stats', asyncHandler(async (req, res) => {
    const userId = req.user.userId;

    // Get comprehensive user statistics
    const statsResult = await query(`
        SELECT 
            -- Account statistics
            COUNT(DISTINCT a.account_id) as total_accounts,
            COALESCE(SUM(a.balance), 0) as total_balance,
            
            -- Transaction statistics
            COUNT(DISTINCT t.transaction_id) as total_transactions,
            COUNT(DISTINCT CASE WHEN t.transaction_type = 'income' THEN t.transaction_id END) as income_transactions,
            COUNT(DISTINCT CASE WHEN t.transaction_type = 'expense' THEN t.transaction_id END) as expense_transactions,
            
            -- Budget statistics
            COUNT(DISTINCT b.budget_id) as total_budgets,
            COUNT(DISTINCT CASE WHEN b.end_date >= CURRENT_DATE THEN b.budget_id END) as active_budgets,
            
            -- Goal statistics
            COUNT(DISTINCT g.goal_id) as total_goals,
            COUNT(DISTINCT CASE WHEN g.target_date >= CURRENT_DATE AND g.current_amount < g.target_amount THEN g.goal_id END) as active_goals
            
        FROM users u
        LEFT JOIN accounts a ON u.user_id = a.user_id
        LEFT JOIN transactions t ON a.account_id = t.account_id
        LEFT JOIN budgets b ON u.user_id = b.user_id
        LEFT JOIN goals g ON u.user_id = g.user_id
        WHERE u.user_id = $1
        GROUP BY u.user_id
    `, [userId]);

    // Get recent activity
    const recentActivity = await query(`
        SELECT 
            'transaction' as activity_type,
            t.transaction_date as activity_date,
            CONCAT(INITCAP(t.transaction_type), ': $', t.amount, ' - ', t.description) as activity_description
        FROM transactions t
        JOIN accounts a ON t.account_id = a.account_id
        WHERE a.user_id = $1
        
        UNION ALL
        
        SELECT 
            'budget' as activity_type,
            b.created_at as activity_date,
            CONCAT('Budget created: ', b.budget_name) as activity_description
        FROM budgets b
        WHERE b.user_id = $1
        
        UNION ALL
        
        SELECT 
            'goal' as activity_type,
            g.created_at as activity_date,
            CONCAT('Goal created: ', g.goal_name) as activity_description
        FROM goals g
        WHERE g.user_id = $1
        
        ORDER BY activity_date DESC
        LIMIT 10
    `, [userId]);

    const stats = statsResult.rows[0] || {};

    res.json({
        success: true,
        data: {
            overview: {
                totalAccounts: parseInt(stats.total_accounts) || 0,
                totalBalance: parseFloat(stats.total_balance) || 0,
                totalTransactions: parseInt(stats.total_transactions) || 0,
                incomeTransactions: parseInt(stats.income_transactions) || 0,
                expenseTransactions: parseInt(stats.expense_transactions) || 0,
                totalBudgets: parseInt(stats.total_budgets) || 0,
                activeBudgets: parseInt(stats.active_budgets) || 0,
                totalGoals: parseInt(stats.total_goals) || 0,
                activeGoals: parseInt(stats.active_goals) || 0
            },
            recentActivity: recentActivity.rows
        }
    });
}));

// Delete user account
router.delete('/account', asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    
    // Note: In a production system, you might want to implement a soft delete
    // or require additional confirmation steps
    
    // Check if user has any active budgets or goals
    const activeItemsResult = await query(`
        SELECT 
            COUNT(CASE WHEN b.end_date >= CURRENT_DATE THEN 1 END) as active_budgets,
            COUNT(CASE WHEN g.target_date >= CURRENT_DATE AND g.current_amount < g.target_amount THEN 1 END) as active_goals
        FROM users u
        LEFT JOIN budgets b ON u.user_id = b.user_id
        LEFT JOIN goals g ON u.user_id = g.user_id
        WHERE u.user_id = $1
    `, [userId]);

    const activeItems = activeItemsResult.rows[0];
    
    if (parseInt(activeItems.active_budgets) > 0 || parseInt(activeItems.active_goals) > 0) {
        return res.status(400).json({
            success: false,
            message: 'Cannot delete account with active budgets or goals. Please complete or delete them first.',
            data: {
                activeBudgets: parseInt(activeItems.active_budgets),
                activeGoals: parseInt(activeItems.active_goals)
            }
        });
    }

    // Delete user (cascade will handle related records)
    await query('DELETE FROM users WHERE user_id = $1', [userId]);

    res.json({
        success: true,
        message: 'User account deleted successfully'
    });
}));

module.exports = router;