const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// Get personalized dashboard summary for authenticated user
router.get('/personalized-summary', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('SET search_path TO finance, public');
        await client.query(`SET app.current_user_id = '${req.user.user_id}'`);
        
        const userId = req.user.user_id;
        
        // Get user basic info
        const userResult = await client.query(`
            SELECT user_id, username, email, first_name, last_name, 
                   date_created, last_login, is_active
            FROM finance.users 
            WHERE user_id = $1 AND is_active = true
        `, [userId]);
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        
        const user = userResult.rows[0];
        
        // Check what data user has
        const dataStatusQueries = await Promise.all([
            // Check accounts
            client.query(`
                SELECT COUNT(*) as count, COALESCE(SUM(current_balance), 0) as net_worth
                FROM finance.accounts 
                WHERE user_id = $1
            `, [userId]),
            
            // Check transactions this month
            client.query(`
                SELECT 
                    COUNT(*) as count,
                    COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) as monthly_income,
                    COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) as monthly_expenses
                FROM finance.transactions t
                JOIN finance.accounts a ON t.account_id = a.account_id
                WHERE a.user_id = $1 
                AND t.transaction_date >= DATE_TRUNC('month', CURRENT_DATE)
            `, [userId]),
            
            // Check budgets
            client.query(`
                SELECT COUNT(*) as count
                FROM finance.budgets 
                WHERE user_id = $1
            `, [userId]),
            
            // Check goals (budgets as goals for now)
            client.query(`
                SELECT COUNT(*) as count
                FROM finance.budgets 
                WHERE user_id = $1 AND total_budget > 0
            `, [userId])
        ]);
        
        const [accountsData, transactionsData, budgetsData, goalsData] = dataStatusQueries.map(q => q.rows[0]);
        
        // Generate personalized insights
        let personalizedInsight = null;
        const netWorth = parseFloat(accountsData.net_worth);
        const monthlyIncome = parseFloat(transactionsData.monthly_income);
        const monthlyExpenses = parseFloat(transactionsData.monthly_expenses);
        const netSavings = monthlyIncome - monthlyExpenses;
        
        if (accountsData.count == 0) {
            personalizedInsight = "Welcome! Let's start by adding your first account.";
        } else if (transactionsData.count == 0) {
            personalizedInsight = "Great! Now let's add some transactions to track your spending.";
        } else if (netSavings > 0) {
            personalizedInsight = `You saved $${netSavings.toFixed(2)} this month - excellent work!`;
        } else if (netSavings < 0) {
            personalizedInsight = `You spent $${Math.abs(netSavings).toFixed(2)} more than you earned this month.`;
        } else {
            personalizedInsight = "Your income and expenses are perfectly balanced this month.";
        }
        
        // Calculate budget progress if user has budgets
        let budgetProgress = null;
        if (budgetsData.count > 0) {
            const budgetResult = await client.query(`
                SELECT 
                    SUM(b.budget_amount) as total_budget,
                    SUM(COALESCE(spent.amount, 0)) as total_spent
                FROM finance.budgets b
                LEFT JOIN (
                    SELECT 
                        c.category_id,
                        SUM(ABS(t.amount)) as amount
                    FROM finance.transactions t
                    JOIN finance.accounts a ON t.account_id = a.account_id
                    JOIN finance.categories c ON t.category_id = c.category_id
                    WHERE a.user_id = $1
                    AND t.transaction_date >= DATE_TRUNC('month', CURRENT_DATE)
                    AND t.amount < 0
                    GROUP BY c.category_id
                ) spent ON b.category_id = spent.category_id
                WHERE b.user_id = $1
                AND EXTRACT(YEAR FROM b.budget_month) = EXTRACT(YEAR FROM CURRENT_DATE)
                AND EXTRACT(MONTH FROM b.budget_month) = EXTRACT(MONTH FROM CURRENT_DATE)
            `, [userId]);
            
            if (budgetResult.rows.length > 0 && budgetResult.rows[0].total_budget > 0) {
                const totalBudget = parseFloat(budgetResult.rows[0].total_budget);
                const totalSpent = parseFloat(budgetResult.rows[0].total_spent || 0);
                budgetProgress = Math.round((totalSpent / totalBudget) * 100);
            }
        }
        
        // Generate time-based greeting
        const currentHour = new Date().getHours();
        let timeBasedGreeting;
        if (currentHour < 12) {
            timeBasedGreeting = "Good morning";
        } else if (currentHour < 17) {
            timeBasedGreeting = "Good afternoon";
        } else {
            timeBasedGreeting = "Good evening";
        }
        
        res.json({
            success: true,
            data: {
                user: {
                    firstName: user.first_name,
                    lastName: user.last_name,
                    username: user.username,
                    email: user.email,
                    memberSince: user.date_created,
                    lastLogin: user.last_login
                },
                hasAccounts: accountsData.count > 0,
                hasTransactions: transactionsData.count > 0,
                hasBudgets: budgetsData.count > 0,
                hasGoals: goalsData.count > 0,
                netWorth: netWorth,
                monthlyIncome: monthlyIncome,
                monthlyExpenses: monthlyExpenses,
                netSavings: netSavings,
                budgetProgress: budgetProgress,
                personalizedInsight: personalizedInsight,
                timeBasedGreeting: timeBasedGreeting
            }
        });
        
    } catch (error) {
        console.error('Dashboard API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load dashboard data'
        });
    } finally {
        client.release();
    }
});

// Get user's account summary
router.get('/user-accounts', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('SET search_path TO finance, public');
        await client.query(`SET app.current_user_id = '${req.user.user_id}'`);
        
        const userId = req.user.user_id;
        
        const result = await client.query(`
            SELECT 
                a.account_id,
                a.account_name,
                a.current_balance,
                a.date_created,
                at.type_name,
                at.allows_negative_balance,
                at.is_asset,
                COUNT(t.transaction_id) as transaction_count,
                MAX(t.transaction_date) as last_transaction_date
            FROM finance.accounts a
            JOIN finance.account_types at ON a.type_id = at.type_id
            LEFT JOIN finance.transactions t ON a.account_id = t.account_id
            WHERE a.user_id = $1
            GROUP BY a.account_id, a.account_name, a.current_balance, a.date_created, 
                     at.type_name, at.allows_negative_balance, at.is_asset
            ORDER BY a.date_created DESC
        `, [userId]);
        
        res.json({
            success: true,
            data: result.rows.map(account => ({
                id: account.account_id,
                name: account.account_name,
                balance: parseFloat(account.current_balance),
                type: account.type_name,
                isAsset: account.is_asset,
                allowsNegative: account.allows_negative_balance,
                transactionCount: parseInt(account.transaction_count),
                lastTransaction: account.last_transaction_date,
                createdAt: account.date_created
            }))
        });
        
    } catch (error) {
        console.error('User Accounts API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load accounts'
        });
    } finally {
        client.release();
    }
});

// Get user's recent transactions
router.get('/user-transactions', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('SET search_path TO finance, public');
        await client.query(`SET app.current_user_id = '${req.user.user_id}'`);
        
        const userId = req.user.user_id;
        const limit = parseInt(req.query.limit) || 10;
        
        const result = await client.query(`
            SELECT 
                t.transaction_id,
                t.amount,
                t.description,
                t.transaction_date,
                t.notes,
                a.account_name,
                c.category_name,
                c.category_type
            FROM finance.transactions t
            JOIN finance.accounts a ON t.account_id = a.account_id
            LEFT JOIN finance.categories c ON t.category_id = c.category_id
            WHERE a.user_id = $1
            ORDER BY t.transaction_date DESC, t.transaction_id DESC
            LIMIT $2
        `, [userId, limit]);
        
        res.json({
            success: true,
            data: result.rows.map(transaction => ({
                id: transaction.transaction_id,
                amount: parseFloat(transaction.amount),
                description: transaction.description,
                date: transaction.transaction_date,
                notes: transaction.notes,
                account: transaction.account_name,
                category: transaction.category_name,
                categoryType: transaction.category_type,
                type: parseFloat(transaction.amount) >= 0 ? 'income' : 'expense'
            }))
        });
        
    } catch (error) {
        console.error('User Transactions API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load transactions'
        });
    } finally {
        client.release();
    }
});

// Get user's spending categories (based on their actual transactions)
router.get('/user-categories', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('SET search_path TO finance, public');
        await client.query(`SET app.current_user_id = '${req.user.user_id}'`);
        
        const userId = req.user.user_id;
        
        const result = await client.query(`
            SELECT 
                c.category_id,
                c.category_name,
                c.category_type,
                COUNT(t.transaction_id) as transaction_count,
                SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) as total_spent,
                AVG(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE NULL END) as avg_transaction
            FROM finance.categories c
            JOIN finance.transactions t ON c.category_id = t.category_id
            JOIN finance.accounts a ON t.account_id = a.account_id
            WHERE a.user_id = $1
            GROUP BY c.category_id, c.category_name, c.category_type
            HAVING COUNT(t.transaction_id) > 0
            ORDER BY total_spent DESC
        `, [userId]);
        
        res.json({
            success: true,
            data: result.rows.map(category => ({
                id: category.category_id,
                name: category.category_name,
                type: category.category_type,
                transactionCount: parseInt(category.transaction_count),
                totalSpent: parseFloat(category.total_spent || 0),
                avgTransaction: parseFloat(category.avg_transaction || 0)
            }))
        });
        
    } catch (error) {
        console.error('User Categories API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load categories'
        });
    } finally {
        client.release();
    }
});

module.exports = router;