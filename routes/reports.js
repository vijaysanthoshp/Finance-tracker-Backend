const express = require('express');
const { query } = require('../config/database');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

// Get financial summary
router.get('/summary', asyncHandler(async (req, res) => {
    const userId = req.user.userId;

    try {
        // Get account summary
        const accountsResult = await query(`
            SELECT 
                COUNT(*) as accounts_count,
                COALESCE(SUM(current_balance), 0) as total_balance
            FROM accounts 
            WHERE user_id = $1 AND is_active = true
        `, [userId]);

        // Get transaction summary
        const transactionsResult = await query(`
            SELECT 
                COUNT(*) as transactions_count,
                COALESCE(SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END), 0) as total_income,
                COALESCE(SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END), 0) as total_expenses
            FROM transactions t
            JOIN accounts a ON t.account_id = a.account_id
            WHERE a.user_id = $1
        `, [userId]);

        // Get budget summary
        const budgetsResult = await query(`
            SELECT COUNT(*) as active_budgets_count
            FROM budgets 
            WHERE user_id = $1 AND is_active = true AND end_date >= CURRENT_DATE
        `, [userId]);

        const accountData = accountsResult.rows[0] || {};
        const transactionData = transactionsResult.rows[0] || {};
        const budgetData = budgetsResult.rows[0] || {};

        const totalIncome = parseFloat(transactionData.total_income || 0);
        const totalExpenses = parseFloat(transactionData.total_expenses || 0);

        res.json({
            success: true,
            data: {
                totalBalance: parseFloat(accountData.total_balance || 0),
                totalIncome: totalIncome,
                totalExpenses: totalExpenses,
                netWorth: totalIncome - totalExpenses,
                accountsCount: parseInt(accountData.accounts_count || 0),
                transactionsCount: parseInt(transactionData.transactions_count || 0),
                activeBudgetsCount: parseInt(budgetData.active_budgets_count || 0),
                activeGoalsCount: 0 // Placeholder for future feature
            }
        });
    } catch (error) {
        console.error('Error getting financial summary:', error);
        res.json({
            success: true,
            data: {
                totalBalance: 0,
                totalIncome: 0,
                totalExpenses: 0,
                netWorth: 0,
                accountsCount: 0,
                transactionsCount: 0,
                activeBudgetsCount: 0,
                activeGoalsCount: 0
            }
        });
    }
}));

// Get monthly spending analysis
router.get('/monthly-spending', asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const { months = 12 } = req.query;

    try {
        const result = await query(`
            WITH monthly_data AS (
                SELECT 
                    DATE_TRUNC('month', t.transaction_date) as spending_month,
                    SUM(CASE WHEN t.transaction_type = 'income' THEN t.amount ELSE 0 END) as total_income,
                    SUM(CASE WHEN t.transaction_type = 'expense' THEN t.amount ELSE 0 END) as total_expenses,
                    COUNT(*) as transaction_count,
                    AVG(t.amount) as avg_transaction_amount
                FROM transactions t
                JOIN accounts a ON t.account_id = a.account_id
                WHERE a.user_id = $1
                GROUP BY DATE_TRUNC('month', t.transaction_date)
            ),
            monthly_categories AS (
                SELECT 
                    DATE_TRUNC('month', t.transaction_date) as spending_month,
                    c.category_name,
                    SUM(t.amount) as category_amount,
                    ROW_NUMBER() OVER (
                        PARTITION BY DATE_TRUNC('month', t.transaction_date) 
                        ORDER BY SUM(t.amount) DESC
                    ) as rn
                FROM transactions t
                JOIN accounts a ON t.account_id = a.account_id
                JOIN categories c ON t.category_id = c.category_id
                WHERE a.user_id = $1 AND t.transaction_type = 'expense'
                GROUP BY DATE_TRUNC('month', t.transaction_date), c.category_name
            )
            SELECT 
                md.spending_month,
                md.total_income,
                md.total_expenses,
                (md.total_income - md.total_expenses) as net_income,
                md.transaction_count,
                md.avg_transaction_amount,
                mc.category_name as top_spending_category,
                mc.category_amount as top_category_amount
            FROM monthly_data md
            LEFT JOIN monthly_categories mc ON md.spending_month = mc.spending_month AND mc.rn = 1
            ORDER BY md.spending_month DESC
            LIMIT $2
        `, [userId, months]);

        res.json({
            success: true,
            data: result.rows.map(row => ({
                month: row.spending_month,
                totalIncome: parseFloat(row.total_income || 0),
                totalExpenses: parseFloat(row.total_expenses || 0),
                netIncome: parseFloat(row.net_income || 0),
                transactionCount: parseInt(row.transaction_count || 0),
                avgTransactionAmount: parseFloat(row.avg_transaction_amount || 0),
                topCategory: row.top_spending_category,
                topCategoryAmount: parseFloat(row.top_category_amount || 0)
            }))
        });
    } catch (error) {
        console.error('Error getting monthly spending analysis:', error);
        res.json({
            success: true,
            data: []
        });
    }
}));

// Get income vs expenses trend
router.get('/income-vs-expenses', asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const { startDate, endDate, groupBy = 'month' } = req.query;

    let dateFormat, dateTrunc;
    switch (groupBy) {
        case 'day':
            dateFormat = 'YYYY-MM-DD';
            dateTrunc = 'day';
            break;
        case 'week':
            dateFormat = 'YYYY-"W"WW';
            dateTrunc = 'week';
            break;
        case 'year':
            dateFormat = 'YYYY';
            dateTrunc = 'year';
            break;
        default: // month
            dateFormat = 'YYYY-MM';
            dateTrunc = 'month';
    }

    let trendQuery = `
        SELECT 
            TO_CHAR(DATE_TRUNC('${dateTrunc}', t.transaction_date), '${dateFormat}') as period,
            SUM(CASE WHEN t.transaction_type = 'income' THEN t.amount ELSE 0 END) as total_income,
            SUM(CASE WHEN t.transaction_type = 'expense' THEN t.amount ELSE 0 END) as total_expenses,
            COUNT(CASE WHEN t.transaction_type = 'income' THEN 1 END) as income_count,
            COUNT(CASE WHEN t.transaction_type = 'expense' THEN 1 END) as expense_count
        FROM transactions t
        JOIN accounts a ON t.account_id = a.account_id
        WHERE a.user_id = $1
    `;

    const params = [userId];
    let paramCount = 1;

    if (startDate) {
        trendQuery += ` AND t.transaction_date >= $${++paramCount}`;
        params.push(startDate);
    }

    if (endDate) {
        trendQuery += ` AND t.transaction_date <= $${++paramCount}`;
        params.push(endDate);
    }

    trendQuery += `
        GROUP BY DATE_TRUNC('${dateTrunc}', t.transaction_date)
        ORDER BY DATE_TRUNC('${dateTrunc}', t.transaction_date)
    `;

    const result = await query(trendQuery, params);

    res.json({
        success: true,
        data: result.rows.map(row => ({
            period: row.period,
            totalIncome: parseFloat(row.total_income),
            totalExpenses: parseFloat(row.total_expenses),
            netIncome: parseFloat(row.total_income) - parseFloat(row.total_expenses),
            incomeCount: parseInt(row.income_count),
            expenseCount: parseInt(row.expense_count)
        }))
    });
}));

// Get category spending analysis
router.get('/category-spending', asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const { startDate, endDate, type = 'expense', limit = 10 } = req.query;

    let categoryQuery = `
        SELECT 
            c.category_name,
            c.category_type,
            SUM(t.amount) as total_amount,
            COUNT(t.transaction_id) as transaction_count,
            AVG(t.amount) as avg_amount,
            MIN(t.amount) as min_amount,
            MAX(t.amount) as max_amount
        FROM transactions t
        JOIN accounts a ON t.account_id = a.account_id
        JOIN categories c ON t.category_id = c.category_id
        WHERE a.user_id = $1 AND t.transaction_type = $2
    `;

    const params = [userId, type];
    let paramCount = 2;

    if (startDate) {
        categoryQuery += ` AND t.transaction_date >= $${++paramCount}`;
        params.push(startDate);
    }

    if (endDate) {
        categoryQuery += ` AND t.transaction_date <= $${++paramCount}`;
        params.push(endDate);
    }

    categoryQuery += `
        GROUP BY c.category_name, c.category_type
        ORDER BY total_amount DESC
        LIMIT $${++paramCount}
    `;
    params.push(limit);

    const result = await query(categoryQuery, params);

    // Calculate total for percentage calculation
    const totalResult = await query(`
        SELECT SUM(t.amount) as total
        FROM transactions t
        JOIN accounts a ON t.account_id = a.account_id
        WHERE a.user_id = $1 AND t.transaction_type = $2
        ${startDate ? ` AND t.transaction_date >= '${startDate}'` : ''}
        ${endDate ? ` AND t.transaction_date <= '${endDate}'` : ''}
    `, [userId, type]);

    const totalAmount = parseFloat(totalResult.rows[0].total) || 1;

    res.json({
        success: true,
        data: result.rows.map(row => ({
            categoryName: row.category_name,
            categoryType: row.category_type,
            totalAmount: parseFloat(row.total_amount),
            percentage: (parseFloat(row.total_amount) / totalAmount) * 100,
            transactionCount: parseInt(row.transaction_count),
            avgAmount: parseFloat(row.avg_amount),
            minAmount: parseFloat(row.min_amount),
            maxAmount: parseFloat(row.max_amount)
        }))
    });
}));

// Get account balances over time
router.get('/account-balances', asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const { accountId, startDate, endDate, limit = 30 } = req.query;

    let balanceQuery = `
        SELECT 
            a.account_name,
            a.account_type,
            DATE(t.transaction_date) as date,
            SUM(CASE WHEN t.transaction_type = 'income' THEN t.amount ELSE -t.amount END) OVER (
                PARTITION BY a.account_id
                ORDER BY DATE(t.transaction_date), t.transaction_id
                ROWS UNBOUNDED PRECEDING
            ) as running_balance
        FROM accounts a
        JOIN transactions t ON a.account_id = t.account_id
        WHERE a.user_id = $1
    `;

    const params = [userId];
    let paramCount = 1;

    if (accountId) {
        balanceQuery += ` AND a.account_id = $${++paramCount}`;
        params.push(accountId);
    }

    if (startDate) {
        balanceQuery += ` AND t.transaction_date >= $${++paramCount}`;
        params.push(startDate);
    }

    if (endDate) {
        balanceQuery += ` AND t.transaction_date <= $${++paramCount}`;
        params.push(endDate);
    }

    balanceQuery += `
        ORDER BY a.account_name, DATE(t.transaction_date) DESC, t.transaction_id DESC
        LIMIT $${++paramCount}
    `;
    params.push(limit);

    const result = await query(balanceQuery, params);

    res.json({
        success: true,
        data: result.rows.map(row => ({
            accountName: row.account_name,
            accountType: row.account_type,
            date: row.date,
            balance: parseFloat(row.running_balance)
        }))
    });
}));

// Get budget performance report
router.get('/budget-performance', asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const { active } = req.query;

    let budgetQuery = `
        SELECT 
            b.budget_id,
            b.budget_name,
            b.start_date,
            b.end_date,
            b.total_budget,
            b.created_date,
            b.is_active,
            CASE 
                WHEN b.end_date >= CURRENT_DATE AND b.start_date <= CURRENT_DATE THEN true
                ELSE false
            END as is_active_period,
            -- Calculate total spent for this budget
            COALESCE((
                SELECT SUM(ABS(t.amount))
                FROM transactions t
                WHERE t.user_id = b.user_id 
                  AND t.transaction_date BETWEEN b.start_date AND b.end_date
                  AND t.type = 'EXPENSE'
            ), 0) as total_spent
        FROM budgets b
        WHERE b.user_id = $1 AND b.is_active = true
    `;

    const params = [userId];

    if (active === 'true') {
        budgetQuery += ` AND is_active = true`;
    } else if (active === 'false') {
        budgetQuery += ` AND is_active = false`;
    }

    budgetQuery += ` ORDER BY budget_name`;

    const result = await query(budgetQuery, params);

    res.json({
        success: true,
        data: result.rows.map(budget => ({
            budgetId: budget.budget_id,
            budgetName: budget.budget_name,
            startDate: budget.start_date,
            endDate: budget.end_date,
            totalLimit: parseFloat(budget.total_limit),
            totalSpent: parseFloat(budget.total_spent),
            remainingAmount: parseFloat(budget.remaining_amount),
            utilizationPercentage: parseFloat(budget.utilization_percentage),
            isOverBudget: budget.is_over_budget,
            daysRemaining: budget.days_remaining,
            isActive: budget.is_active
        }))
    });
}));

// Get financial health score and insights
router.get('/financial-health', asyncHandler(async (req, res) => {
    const userId = req.user.userId;

    // Get basic financial metrics
    const metricsResult = await query(`
        SELECT 
            COALESCE(SUM(a.current_balance), 0) as total_balance,
            COUNT(a.account_id) as account_count,
            (
                SELECT COALESCE(SUM(t.amount), 0)
                FROM transactions t
                JOIN accounts acc ON t.account_id = acc.account_id
                WHERE acc.user_id = $1 
                AND t.transaction_type = 'income'
                AND t.transaction_date >= CURRENT_DATE - INTERVAL '30 days'
            ) as monthly_income,
            (
                SELECT COALESCE(SUM(t.amount), 0)
                FROM transactions t
                JOIN accounts acc ON t.account_id = acc.account_id
                WHERE acc.user_id = $1 
                AND t.transaction_type = 'expense'
                AND t.transaction_date >= CURRENT_DATE - INTERVAL '30 days'
            ) as monthly_expenses,
            (
                SELECT COUNT(*)
                FROM budgets b
                WHERE b.user_id = $1
                AND b.end_date >= CURRENT_DATE
                AND b.start_date <= CURRENT_DATE
            ) as active_budgets
        FROM accounts a
        WHERE a.user_id = $1
    `, [userId]);

    const metrics = metricsResult.rows[0];

    // Calculate financial health score
    let healthScore = 0;
    const insights = [];

    // Balance score (0-30 points)
    const totalBalance = parseFloat(metrics.total_balance);
    if (totalBalance > 10000) {
        healthScore += 30;
        insights.push({ type: 'positive', message: 'Excellent savings balance' });
    } else if (totalBalance > 5000) {
        healthScore += 20;
        insights.push({ type: 'neutral', message: 'Good savings balance' });
    } else if (totalBalance > 1000) {
        healthScore += 10;
        insights.push({ type: 'warning', message: 'Consider increasing your savings' });
    } else {
        insights.push({ type: 'negative', message: 'Low savings balance - focus on building emergency fund' });
    }

    // Income vs Expenses ratio (0-30 points)
    const monthlyIncome = parseFloat(metrics.monthly_income);
    const monthlyExpenses = parseFloat(metrics.monthly_expenses);
    
    if (monthlyIncome > 0) {
        const expenseRatio = monthlyExpenses / monthlyIncome;
        if (expenseRatio < 0.5) {
            healthScore += 30;
            insights.push({ type: 'positive', message: 'Excellent spending discipline' });
        } else if (expenseRatio < 0.7) {
            healthScore += 20;
            insights.push({ type: 'positive', message: 'Good spending habits' });
        } else if (expenseRatio < 0.9) {
            healthScore += 10;
            insights.push({ type: 'warning', message: 'Monitor your spending carefully' });
        } else {
            insights.push({ type: 'negative', message: 'Expenses are too high compared to income' });
        }
    }

    // Budgeting behavior (0-20 points)
    const activeBudgets = parseInt(metrics.active_budgets);
    if (activeBudgets > 0) {
        healthScore += 20;
        insights.push({ type: 'positive', message: 'Great job maintaining active budgets' });
    } else {
        insights.push({ type: 'warning', message: 'Consider creating budgets to track spending' });
    }

    // Account diversification (0-20 points)
    const accountCount = parseInt(metrics.account_count);
    if (accountCount >= 3) {
        healthScore += 20;
        insights.push({ type: 'positive', message: 'Good account diversification' });
    } else if (accountCount >= 2) {
        healthScore += 10;
        insights.push({ type: 'neutral', message: 'Consider adding more account types' });
    } else {
        insights.push({ type: 'warning', message: 'Consider diversifying your accounts' });
    }

    // Determine overall health level
    let healthLevel;
    if (healthScore >= 80) {
        healthLevel = 'Excellent';
    } else if (healthScore >= 60) {
        healthLevel = 'Good';
    } else if (healthScore >= 40) {
        healthLevel = 'Fair';
    } else {
        healthLevel = 'Needs Improvement';
    }

    res.json({
        success: true,
        data: {
            healthScore,
            healthLevel,
            metrics: {
                totalBalance,
                monthlyIncome,
                monthlyExpenses,
                savingsRate: monthlyIncome > 0 ? ((monthlyIncome - monthlyExpenses) / monthlyIncome) * 100 : 0,
                accountCount,
                activeBudgets
            },
            insights
        }
    });
}));

module.exports = router;