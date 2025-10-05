const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool } = require('../config/database');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

// Validation rules
const createBudgetValidation = [
    body('budgetName')
        .trim()
        .isLength({ min: 1, max: 100 })
        .withMessage('Budget name must be between 1 and 100 characters'),
    body('startDate')
        .isISO8601()
        .withMessage('Start date must be a valid ISO date'),
    body('endDate')
        .isISO8601()
        .withMessage('End date must be a valid ISO date'),
    body('totalLimit')
        .isFloat({ min: 0 })
        .withMessage('Total limit must be a positive number'),
    body('categories')
        .isArray()
        .withMessage('Categories must be an array'),
    body('categories.*.categoryId')
        .isInt({ min: 1 })
        .withMessage('Valid category ID is required'),
    body('categories.*.allocatedAmount')
        .isFloat({ min: 0 })
        .withMessage('Allocated amount must be a positive number')
];

// Get all user budgets
router.get('/', asyncHandler(async (req, res) => {
    const userId = req.user.user_id;  // Fixed: use user_id instead of userId
    const { active, startDate, endDate } = req.query;

    // Get database connection and set RLS context
    const client = await pool.connect();
    try {
        await client.query(`SET search_path TO finance`);
        await client.query(`SET app.current_user_id = '${userId}'`);

        let budgetQuery = `
            SELECT 
                b.budget_id,
                b.budget_name,
                b.start_date,
                b.end_date,
                b.total_budget,
                b.created_date AS created_at,
                b.created_date AS updated_at,
                CASE 
                    WHEN b.end_date >= CURRENT_DATE AND b.start_date <= CURRENT_DATE THEN true
                    ELSE false
                END as is_active,
                -- Calculate total spent for this budget
                COALESCE((
                    SELECT SUM(ABS(t.amount))
                    FROM transactions t
                    JOIN accounts a ON t.account_id = a.account_id
                    WHERE a.user_id = b.user_id 
                      AND t.transaction_date BETWEEN b.start_date AND b.end_date
                      AND t.transaction_type = 'EXPENSE'
                ), 0) as total_spent
            FROM budgets b
            WHERE b.user_id = $1 AND b.is_active = true
        `;

        const params = [userId];
        let paramCount = 1;

        if (active === 'true') {
            budgetQuery += ` AND b.end_date >= CURRENT_DATE AND b.start_date <= CURRENT_DATE`;
        } else if (active === 'false') {
            budgetQuery += ` AND (b.end_date < CURRENT_DATE OR b.start_date > CURRENT_DATE)`;
        }

        if (startDate) {
            budgetQuery += ` AND b.start_date >= $${++paramCount}`;
            params.push(startDate);
        }

        if (endDate) {
            budgetQuery += ` AND b.end_date <= $${++paramCount}`;
            params.push(endDate);
        }

        budgetQuery += ` ORDER BY b.created_date DESC`;

        const result = await client.query(budgetQuery, params);

        res.json({
            success: true,
            data: result.rows.map(budget => ({
                id: budget.budget_id,
                name: budget.budget_name,
                startDate: budget.start_date,
                endDate: budget.end_date,
                totalLimit: parseFloat(budget.total_budget),
                totalSpent: parseFloat(budget.total_spent || 0),
                percentUsed: budget.total_budget > 0 ? (parseFloat(budget.total_spent || 0) / parseFloat(budget.total_budget) * 100) : 0,
                isOverBudget: parseFloat(budget.total_spent || 0) > parseFloat(budget.total_budget),
                isActive: budget.is_active,
                remainingAmount: parseFloat(budget.total_budget) - parseFloat(budget.total_spent || 0),
                createdAt: budget.created_at,
                updatedAt: budget.updated_at
            }))
        });
    } finally {
        client.release();
    }
}));

// Get specific budget by ID with performance details
router.get('/:id', asyncHandler(async (req, res) => {
    const userId = req.user.user_id;
    const budgetId = req.params.id;

    // Get database connection and set RLS context
    const client = await pool.connect();
    try {
        await client.query(`SET search_path TO finance`);
        await client.query(`SET app.current_user_id = '${userId}'`);

        // Get budget details with performance data
        const budgetResult = await client.query(`
            SELECT 
                b.budget_id,
                b.budget_name,
                b.start_date,
                b.end_date,
                b.total_budget,
                b.created_date,
                b.is_active,
                -- Calculate total spent for this budget
                COALESCE((
                    SELECT SUM(ABS(t.amount))
                    FROM transactions t
                    JOIN accounts a ON t.account_id = a.account_id
                    WHERE a.user_id = b.user_id 
                      AND t.transaction_date BETWEEN b.start_date AND b.end_date
                      AND t.transaction_type = 'EXPENSE'
                ), 0) as total_spent
            FROM budgets b
            WHERE b.user_id = $1 AND b.budget_id = $2 AND b.is_active = true
        `, [userId, budgetId]);

        if (budgetResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Budget not found'
            });
        }

        const budget = budgetResult.rows[0];

        // Get category allocations and spending
        const categoriesResult = await client.query(`
        SELECT 
            bc.category_id,
            bc.allocated_amount,
            c.category_name,
            c.category_type,
            COALESCE(SUM(t.amount), 0) as spent_amount
        FROM budget_categories bc
        JOIN categories c ON bc.category_id = c.category_id
        LEFT JOIN transactions t ON c.category_id = t.category_id
            AND t.transaction_type = 'EXPENSE'
            AND t.transaction_date BETWEEN $2 AND $3
            AND t.account_id IN (
                SELECT account_id FROM accounts WHERE user_id = $1
            )
        WHERE bc.budget_id = $4
        GROUP BY bc.category_id, bc.allocated_amount, c.category_name, c.category_type
        ORDER BY c.category_name
    `, [userId, budget.start_date, budget.end_date, budgetId]);

    res.json({
        success: true,
        data: {
            id: budget.budget_id,
            name: budget.budget_name,
            startDate: budget.start_date,
            endDate: budget.end_date,
            totalLimit: parseFloat(budget.total_budget),
            totalSpent: parseFloat(budget.total_spent),
            remainingAmount: parseFloat(budget.remaining_amount),
            utilizationPercentage: parseFloat(budget.utilization_percentage),
            isOverBudget: budget.is_over_budget,
            daysRemaining: budget.days_remaining,
            isActive: budget.is_active,
            categories: categoriesResult.rows.map(category => ({
                id: category.category_id,
                name: category.category_name,
                type: category.category_type,
                allocatedAmount: parseFloat(category.allocated_amount),
                spentAmount: parseFloat(category.spent_amount),
                remainingAmount: parseFloat(category.allocated_amount) - parseFloat(category.spent_amount),
                utilizationPercentage: (parseFloat(category.spent_amount) / parseFloat(category.allocated_amount)) * 100
            }))
        }
    });
    } finally {
        client.release();
    }
}));

// Create new budget
router.post('/', createBudgetValidation, asyncHandler(async (req, res) => {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            message: 'Validation errors',
            errors: errors.array()
        });
    }

    const userId = req.user.user_id;
    const { budgetName, startDate, endDate, totalLimit, categories, notes } = req.body;

    // Validate date range
    if (new Date(endDate) <= new Date(startDate)) {
        return res.status(400).json({
            success: false,
            message: 'End date must be after start date'
        });
    }

    // Validate that total allocated amount doesn't exceed total limit (if categories provided)
    const totalAllocated = categories.length > 0 ? categories.reduce((sum, cat) => sum + parseFloat(cat.allocatedAmount), 0) : 0;
    if (totalAllocated > parseFloat(totalLimit)) {
        return res.status(400).json({
            success: false,
            message: `Total allocated amount ($${totalAllocated.toFixed(2)}) exceeds budget limit ($${parseFloat(totalLimit).toFixed(2)})`
        });
    }

    // Get database connection and set RLS context
    const client = await pool.connect();
    try {
        console.log('🔧 Budget Creation - Setting up database context for user:', userId);
        console.log('🔧 Budget data:', { budgetName, startDate, endDate, totalLimit, categories });
        await client.query(`SET search_path TO finance`);
        await client.query(`SET app.current_user_id = '${userId}'`);

        // Allow multiple active budgets with overlapping periods
        // This enables realistic budget management like real banking systems
        console.log('💰 Creating budget - multiple active budgets allowed');

        // Verify all categories exist (if any provided)
        if (categories.length > 0) {
            const categoryIds = categories.map(cat => cat.categoryId);
            const categoryCheck = await client.query(`
                SELECT category_id FROM categories 
                WHERE category_id = ANY($1)
            `, [categoryIds]);

            if (categoryCheck.rows.length !== categoryIds.length) {
                return res.status(400).json({
                    success: false,
                    message: 'One or more categories not found'
                });
            }
        }

        // Create budget using stored procedure
        console.log('🔧 Creating budget with function call...');
        const budgetResult = await client.query(
            'SELECT create_budget($1, $2, $3, $4, $5) as budget_id',
            [userId, budgetName, startDate, endDate, totalLimit]
        );

        const budgetId = budgetResult.rows[0].budget_id;
        console.log('✅ Budget created with ID:', budgetId);

        // Add category allocations (only for categories with non-zero amounts)
        const categoriesWithAllocations = categories.filter(cat => cat.allocatedAmount > 0);
        if (categoriesWithAllocations.length > 0) {
            console.log('🔧 Adding category allocations...');
            for (const category of categoriesWithAllocations) {
                console.log(`Adding category ${category.categoryId} with amount $${category.allocatedAmount}`);
                await client.query(`
                    INSERT INTO budget_categories (budget_id, category_id, allocated_amount)
                    VALUES ($1, $2, $3)
                `, [budgetId, category.categoryId, category.allocatedAmount]);
            }
            console.log('✅ All category allocations added');
        } else {
            console.log('ℹ️ No category allocations to add (all categories have zero amounts)');
        }

        // Get the created budget details
        const createdBudget = await client.query(`
            SELECT 
                budget_id,
                budget_name,
                start_date,
                end_date,
                total_budget,
                created_date
            FROM budgets 
            WHERE budget_id = $1
        `, [budgetId]);

        res.status(201).json({
            success: true,
            message: 'Budget created successfully',
            data: {
                id: createdBudget.rows[0].budget_id,
                name: createdBudget.rows[0].budget_name,
                startDate: createdBudget.rows[0].start_date,
                endDate: createdBudget.rows[0].end_date,
                totalLimit: parseFloat(createdBudget.rows[0].total_budget),
                createdAt: createdBudget.rows[0].created_date,
                categoriesCount: categories.length
            }
        });
    } catch (error) {
        console.log('❌ Budget Creation Error:', error.message);
        console.log('❌ Error Code:', error.code);
        console.log('❌ Error Detail:', error.detail || 'None');
        console.log('❌ Error Stack:', error.stack);
        throw error; // Re-throw for asyncHandler to handle
    } finally {
        client.release();
    }
}));

// Update budget
router.put('/:id', [
    body('budgetName')
        .optional()
        .trim()
        .isLength({ min: 1, max: 100 })
        .withMessage('Budget name must be between 1 and 100 characters'),
    body('startDate')
        .optional()
        .isISO8601()
        .withMessage('Start date must be a valid ISO date'),
    body('endDate')
        .optional()
        .isISO8601()
        .withMessage('End date must be a valid ISO date'),
    body('totalLimit')
        .optional()
        .isFloat({ min: 0 })
        .withMessage('Total limit must be a positive number')
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

    const userId = req.user.user_id;
    const budgetId = req.params.id;
    const { budgetName, startDate, endDate, totalLimit } = req.body;

    // Verify budget ownership
    const ownershipCheck = await query(
        'SELECT budget_id, start_date, end_date FROM budgets WHERE user_id = $1 AND budget_id = $2',
        [userId, budgetId]
    );

    if (ownershipCheck.rows.length === 0) {
        return res.status(404).json({
            success: false,
            message: 'Budget not found'
        });
    }

    const currentBudget = ownershipCheck.rows[0];

    // Validate date range if both dates are provided
    const newStartDate = startDate || currentBudget.start_date;
    const newEndDate = endDate || currentBudget.end_date;

    if (new Date(newEndDate) <= new Date(newStartDate)) {
        return res.status(400).json({
            success: false,
            message: 'End date must be after start date'
        });
    }

    // Build update query dynamically
    const updateFields = [];
    const updateValues = [];
    let paramCount = 0;

    if (budgetName !== undefined) {
        updateFields.push(`budget_name = $${++paramCount}`);
        updateValues.push(budgetName);
    }

    if (startDate !== undefined) {
        updateFields.push(`start_date = $${++paramCount}`);
        updateValues.push(startDate);
    }

    if (endDate !== undefined) {
        updateFields.push(`end_date = $${++paramCount}`);
        updateValues.push(endDate);
    }

    if (totalLimit !== undefined) {
        updateFields.push(`total_budget = $${++paramCount}`);
        updateValues.push(totalLimit);
    }

    if (updateFields.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'No valid fields to update'
        });
    }

    // Add updated_at field
    updateFields.push(`updated_at = NOW()`);
    
    // Add budget_id for WHERE clause
    updateValues.push(budgetId);
    
    const updateQuery = `
        UPDATE budgets 
        SET ${updateFields.join(', ')}
        WHERE budget_id = $${updateValues.length}
        RETURNING *
    `;

    const result = await query(updateQuery, updateValues);

    res.json({
        success: true,
        message: 'Budget updated successfully',
        data: {
            id: result.rows[0].budget_id,
            name: result.rows[0].budget_name,
            startDate: result.rows[0].start_date,
            endDate: result.rows[0].end_date,
            totalLimit: parseFloat(result.rows[0].total_budget),
            updatedAt: result.rows[0].updated_at
        }
    });
}));

// Delete budget
router.delete('/:id', asyncHandler(async (req, res) => {
    const userId = req.user.user_id;
    const budgetId = req.params.id;

    // Verify budget ownership
    const ownershipCheck = await query(
        'SELECT budget_id, budget_name FROM budgets WHERE user_id = $1 AND budget_id = $2',
        [userId, budgetId]
    );

    if (ownershipCheck.rows.length === 0) {
        return res.status(404).json({
            success: false,
            message: 'Budget not found'
        });
    }

    // Delete budget (cascade will handle budget_categories)
    await query('DELETE FROM budgets WHERE budget_id = $1', [budgetId]);

    res.json({
        success: true,
        message: 'Budget deleted successfully'
    });
}));

// Get budget performance analytics
router.get('/:id/analytics', asyncHandler(async (req, res) => {
    const userId = req.user.user_id;
    const budgetId = req.params.id;

    // Get database connection and set RLS context
    const client = await pool.connect();
    try {
        await client.query(`SET search_path TO finance`);
        await client.query(`SET app.current_user_id = '${userId}'`);

        // Verify budget ownership
        const ownershipCheck = await client.query(
            'SELECT budget_id FROM budgets WHERE user_id = $1 AND budget_id = $2',
            [userId, budgetId]
        );

        if (ownershipCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Budget not found'
            });
        }

        // Get daily spending trend
        const spendingTrend = await client.query(`
        SELECT 
            DATE(t.transaction_date) as date,
            SUM(t.amount) as daily_spending,
            COUNT(*) as transaction_count
        FROM transactions t
        JOIN accounts a ON t.account_id = a.account_id
        JOIN budget_categories bc ON t.category_id = bc.category_id
        JOIN budgets b ON bc.budget_id = b.budget_id
        WHERE a.user_id = $1 
        AND b.budget_id = $2
        AND t.transaction_type = 'EXPENSE'
        AND t.transaction_date BETWEEN b.start_date AND b.end_date
        GROUP BY DATE(t.transaction_date)
        ORDER BY DATE(t.transaction_date)
    `, [userId, budgetId]);

        // Get category-wise spending distribution
        const categoryDistribution = await client.query(`
            SELECT 
                c.category_name,
                bc.allocated_amount,
                COALESCE(SUM(t.amount), 0) as spent_amount,
                COUNT(t.transaction_id) as transaction_count
            FROM budget_categories bc
            JOIN categories c ON bc.category_id = c.category_id
            JOIN budgets b ON bc.budget_id = b.budget_id
            LEFT JOIN transactions t ON c.category_id = t.category_id
                AND t.transaction_type = 'EXPENSE'
                AND t.transaction_date BETWEEN b.start_date AND b.end_date
                AND t.account_id IN (
                    SELECT account_id FROM accounts WHERE user_id = $1
                )
            WHERE bc.budget_id = $2
            GROUP BY c.category_name, bc.allocated_amount
            ORDER BY spent_amount DESC
        `, [userId, budgetId]);

        res.json({
            success: true,
            data: {
                spendingTrend: spendingTrend.rows.map(row => ({
                    date: row.date,
                    amount: parseFloat(row.daily_spending),
                    transactionCount: parseInt(row.transaction_count)
                })),
                categoryDistribution: categoryDistribution.rows.map(row => ({
                    categoryName: row.category_name,
                    allocatedAmount: parseFloat(row.allocated_amount),
                    spentAmount: parseFloat(row.spent_amount),
                    transactionCount: parseInt(row.transaction_count),
                    utilizationPercentage: (parseFloat(row.spent_amount) / parseFloat(row.allocated_amount)) * 100
                }))
            }
        });
    } finally {
        client.release();
    }
}));

module.exports = router;
