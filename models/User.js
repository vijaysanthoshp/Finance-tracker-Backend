const { pool } = require('../config/database');
const bcrypt = require('bcryptjs');

class UserModel {
    // Create new user (for registration)
    static async createUser({ username, email, password, full_name }) {
        const client = await pool.connect();
        
        try {
            // Start transaction
            await client.query('BEGIN');
            
            // Set the search path to finance schema
            await client.query('SET search_path TO finance, public');
            
            // Hash password
            const hashedPassword = await bcrypt.hash(password, 12);
            
            // Split full_name into first_name and last_name to match database schema
            const nameParts = full_name.trim().split(' ');
            const first_name = nameParts[0] || '';
            const last_name = nameParts.slice(1).join(' ') || 'User';
            
            // Insert new user - matching the actual database schema (no phone_number field)
            const userResult = await client.query(`
                INSERT INTO finance.users (username, email, password_hash, first_name, last_name)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING user_id, username, email, first_name, last_name, date_created, is_active
            `, [username, email, hashedPassword, first_name, last_name]);
            
            await client.query('COMMIT');
            
            const user = userResult.rows[0];
            
            // Return user data (without password) - format to match expected API response
            return {
                success: true,
                user: {
                    id: user.user_id,
                    username: user.username,
                    email: user.email,
                    fullName: `${user.first_name} ${user.last_name}`.trim(),
                    firstName: user.first_name,
                    lastName: user.last_name,
                    createdAt: user.date_created,
                    isActive: user.is_active
                },
                message: 'User registered successfully!'
            };
            
        } catch (error) {
            await client.query('ROLLBACK');
            
            // Handle specific database errors
            if (error.code === '23505') { // Unique violation
                if (error.constraint === 'users_username_key') {
                    throw new Error('Username already exists');
                }
                if (error.constraint === 'users_email_key') {
                    throw new Error('Email already exists');
                }
            }
            
            throw error;
        } finally {
            client.release();
        }
    }
    
    // Find user by username/email (for login)
    static async findUser(usernameOrEmail) {
        const client = await pool.connect();
        
        try {
            await client.query('SET search_path TO finance, public');
            
            const result = await client.query(`
                SELECT user_id, username, email, password_hash, first_name, last_name,
                       date_created, last_login, is_active
                FROM finance.users 
                WHERE username = $1 OR email = $1 AND is_active = true
            `, [usernameOrEmail]);
            
            return result.rows[0] || null;
            
        } finally {
            client.release();
        }
    }
    
    // Get user profile with account summary
    static async getUserProfile(userId) {
        const client = await pool.connect();
        
        try {
            await client.query('SET search_path TO finance, public');
            
            // Get user info with account summary
            const result = await client.query(`
                SELECT 
                    u.user_id,
                    u.username,
                    u.email,
                    u.first_name,
                    u.last_name,
                    u.date_created,
                    u.last_login,
                    u.is_active,
                    COUNT(a.account_id) as total_accounts,
                    COALESCE(SUM(a.current_balance), 0) as net_worth,
                    COUNT(CASE WHEN at.type_name = 'Checking' THEN 1 END) as checking_accounts,
                    COUNT(CASE WHEN at.type_name = 'Savings' THEN 1 END) as savings_accounts
                FROM finance.users u
                LEFT JOIN finance.accounts a ON u.user_id = a.user_id
                LEFT JOIN finance.account_types at ON a.account_type_id = at.type_id
                WHERE u.user_id = $1 AND u.is_active = true
                GROUP BY u.user_id
            `, [userId]);
            
            return result.rows[0] || null;
            
        } finally {
            client.release();
        }
    }
    
    // Validate password
    static async validatePassword(plainPassword, hashedPassword) {
        return await bcrypt.compare(plainPassword, hashedPassword);
    }

    // Update last login timestamp
    static async updateLastLogin(userId) {
        const client = await pool.connect();
        
        try {
            await client.query('SET search_path TO finance, public');
            
            await client.query(`
                UPDATE finance.users 
                SET last_login = NOW() 
                WHERE user_id = $1
            `, [userId]);
            
        } finally {
            client.release();
        }
    }
}

module.exports = UserModel;