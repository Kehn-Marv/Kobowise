const { createClient } = require('@libsql/client');

let db = null;

/**
 * Get or create the database client
 */
function getDB() {
    if (db) return db;

    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    if (url && url !== 'libsql://your-database-name-your-org.turso.io') {
        // Auto-convert turso:// to libsql:// (common mistake)
        const normalizedUrl = url.replace(/^turso:\/\//, 'libsql://');
        db = createClient({ url: normalizedUrl, authToken });
    } else {
        // Fallback to local SQLite file for development
        db = createClient({ url: 'file:kobowise.db' });
    }

    return db;
}

/**
 * Initialize database tables
 */
async function initDB() {
    const client = getDB();

    await client.executeMultiple(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id TEXT UNIQUE NOT NULL,
            telegram_username TEXT,
            business_name TEXT NOT NULL DEFAULT 'My Business',
            business_type TEXT NOT NULL DEFAULT 'Other',
            onboarding_step TEXT DEFAULT 'new',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
            category TEXT NOT NULL,
            amount REAL NOT NULL,
            description TEXT,
            source TEXT DEFAULT 'text',
            date DATE NOT NULL DEFAULT (date('now')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS health_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            week_start DATE NOT NULL,
            week_end DATE NOT NULL,
            report_json TEXT NOT NULL,
            sent_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date);
        CREATE INDEX IF NOT EXISTS idx_transactions_user_type ON transactions(user_id, type);
        CREATE INDEX IF NOT EXISTS idx_health_reports_user ON health_reports(user_id, week_start);

        CREATE TABLE IF NOT EXISTS admins (
            telegram_id TEXT PRIMARY KEY,
            added_by TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS broadcasts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            admin_id TEXT,
            summary TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS broadcast_logs (
            broadcast_id INTEGER,
            telegram_id TEXT,
            message_id INTEGER,
            FOREIGN KEY(broadcast_id) REFERENCES broadcasts(id)
        );
    `);

    // Schema migrations — add premium & rate-limit columns (safe to run repeatedly)
    const migrations = [
        'ALTER TABLE users ADD COLUMN is_premium INTEGER DEFAULT 0',
        'ALTER TABLE users ADD COLUMN premium_expires_at DATETIME',
        'ALTER TABLE users ADD COLUMN daily_msg_count INTEGER DEFAULT 0',
        'ALTER TABLE users ADD COLUMN last_msg_date DATE',
        'ALTER TABLE users ADD COLUMN language TEXT DEFAULT \'en\'',
        'ALTER TABLE users ADD COLUMN notifications_enabled INTEGER DEFAULT 1',
        'ALTER TABLE users ADD COLUMN location TEXT',
        'ALTER TABLE admins ADD COLUMN notify_preference INTEGER DEFAULT 1', // 0=Off, 1=Realtime, 2=Daily
        'ALTER TABLE broadcasts ADD COLUMN is_deleted INTEGER DEFAULT 0',
        'ALTER TABLE users ADD COLUMN is_blocked INTEGER DEFAULT 0',
        'ALTER TABLE transactions ADD COLUMN payment_method TEXT DEFAULT \'unknown\'',
    ];

    for (const sql of migrations) {
        try { await client.execute(sql); } catch (e) { /* column already exists, safe to ignore */ }
    }

    // Ensure Master Admin exists in DB to track their settings
    if (process.env.MASTER_ADMIN_ID && process.env.MASTER_ADMIN_ID !== 'your_telegram_id_here') {
        try {
            await client.execute({
                sql: 'INSERT OR IGNORE INTO admins (telegram_id, added_by) VALUES (?, ?)',
                args: [String(process.env.MASTER_ADMIN_ID), 'system']
            });
        } catch(e) {}
    }
}

// ============ USER QUERIES ============

async function findUserByTelegramId(telegramId) {
    const client = getDB();
    const result = await client.execute({
        sql: 'SELECT * FROM users WHERE telegram_id = ?',
        args: [String(telegramId)]
    });
    return result.rows[0] || null;
}

async function createUser(telegramId, username) {
    const client = getDB();
    const result = await client.execute({
        sql: 'INSERT INTO users (telegram_id, telegram_username) VALUES (?, ?) ON CONFLICT(telegram_id) DO UPDATE SET telegram_username=excluded.telegram_username RETURNING *',
        args: [String(telegramId), username || null]
    });
    return result.rows[0];
}

async function blockUser(telegramId) {
    const client = getDB();
    await client.execute({
        sql: 'UPDATE users SET is_blocked = 1 WHERE telegram_id = ?',
        args: [String(telegramId)]
    });
}

async function unblockUser(telegramId) {
    const client = getDB();
    await client.execute({
        sql: 'UPDATE users SET is_blocked = 0 WHERE telegram_id = ?',
        args: [String(telegramId)]
    });
}

async function updateUser(telegramId, updates) {
    const client = getDB();
    const fields = [];
    const args = [];

    for (const [key, value] of Object.entries(updates)) {
        fields.push(`${key} = ?`);
        args.push(value);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    args.push(String(telegramId));

    await client.execute({
        sql: `UPDATE users SET ${fields.join(', ')} WHERE telegram_id = ?`,
        args
    });
}

// ============ TRANSACTION QUERIES ============

async function saveTransaction(userId, tx) {
    const client = getDB();
    const result = await client.execute({
        sql: `INSERT INTO transactions (user_id, type, category, amount, description, source, date)
              VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        args: [userId, tx.type, tx.category, tx.amount, tx.description || '', tx.source || 'text', tx.date || new Date().toISOString().split('T')[0]]
    });
    return result.rows[0];
}

async function saveMultipleTransactions(userId, transactions, source) {
    const client = getDB();
    const today = new Date().toISOString().split('T')[0];
    const results = [];

    for (const tx of transactions) {
        const result = await client.execute({
            sql: `INSERT INTO transactions (user_id, type, category, amount, description, source, date)
                  VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
            args: [userId, tx.type, tx.category, tx.amount, tx.description || '', source || 'text', tx.date || today]
        });
        results.push(result.rows[0]);
    }

    return results;
}

async function getTransactions(userId, options = {}) {
    const client = getDB();
    let sql = 'SELECT * FROM transactions WHERE user_id = ?';
    const args = [userId];

    if (options.startDate) {
        sql += ' AND date >= ?';
        args.push(options.startDate);
    }

    if (options.endDate) {
        sql += ' AND date <= ?';
        args.push(options.endDate);
    }

    if (options.type) {
        sql += ' AND type = ?';
        args.push(options.type);
    }

    if (options.category) {
        sql += ' AND category = ?';
        args.push(options.category);
    }

    sql += ' ORDER BY date DESC, created_at DESC';

    if (options.limit) {
        sql += ' LIMIT ?';
        args.push(options.limit);
    }

    const result = await client.execute({ sql, args });
    return result.rows;
}

async function getWeeklySummary(userId, weekStart, weekEnd) {
    const client = getDB();

    const revenueResult = await client.execute({
        sql: `SELECT COALESCE(SUM(amount), 0) as total FROM transactions 
              WHERE user_id = ? AND type = 'income' AND date >= ? AND date <= ?`,
        args: [userId, weekStart, weekEnd]
    });

    const expenseResult = await client.execute({
        sql: `SELECT COALESCE(SUM(amount), 0) as total FROM transactions 
              WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?`,
        args: [userId, weekStart, weekEnd]
    });

    const categoryResult = await client.execute({
        sql: `SELECT category, type, SUM(amount) as total, COUNT(*) as count FROM transactions 
              WHERE user_id = ? AND date >= ? AND date <= ?
              GROUP BY category, type ORDER BY total DESC`,
        args: [userId, weekStart, weekEnd]
    });

    const dailyResult = await client.execute({
        sql: `SELECT date, type, SUM(amount) as total FROM transactions 
              WHERE user_id = ? AND date >= ? AND date <= ?
              GROUP BY date, type ORDER BY date`,
        args: [userId, weekStart, weekEnd]
    });

    const txCountResult = await client.execute({
        sql: `SELECT COUNT(*) as count FROM transactions 
              WHERE user_id = ? AND date >= ? AND date <= ?`,
        args: [userId, weekStart, weekEnd]
    });

    const revenue = Number(revenueResult.rows[0]?.total || 0);
    const expenses = Number(expenseResult.rows[0]?.total || 0);

    return {
        revenue,
        expenses,
        profit: revenue - expenses,
        margin: revenue > 0 ? Math.round(((revenue - expenses) / revenue) * 100 * 10) / 10 : 0,
        categories: categoryResult.rows,
        daily: dailyResult.rows,
        transaction_count: Number(txCountResult.rows[0]?.count || 0)
    };
}

// ============ LIFETIME SUMMARY (for /balance) ============

async function getLifetimeSummary(userId) {
    const client = getDB();

    const revenueResult = await client.execute({
        sql: `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type = 'income'`,
        args: [userId]
    });

    const expenseResult = await client.execute({
        sql: `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type = 'expense'`,
        args: [userId]
    });

    const txCountResult = await client.execute({
        sql: `SELECT COUNT(*) as count FROM transactions WHERE user_id = ?`,
        args: [userId]
    });

    const todayRevenueResult = await client.execute({
        sql: `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type = 'income' AND date = date('now')`,
        args: [userId]
    });

    const todayExpenseResult = await client.execute({
        sql: `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND type = 'expense' AND date = date('now')`,
        args: [userId]
    });

    const revenue = Number(revenueResult.rows[0]?.total || 0);
    const expenses = Number(expenseResult.rows[0]?.total || 0);
    const todayRevenue = Number(todayRevenueResult.rows[0]?.total || 0);
    const todayExpenses = Number(todayExpenseResult.rows[0]?.total || 0);

    return {
        revenue,
        expenses,
        profit: revenue - expenses,
        margin: revenue > 0 ? Math.round(((revenue - expenses) / revenue) * 100 * 10) / 10 : 0,
        transaction_count: Number(txCountResult.rows[0]?.count || 0),
        today_revenue: todayRevenue,
        today_expenses: todayExpenses,
        today_profit: todayRevenue - todayExpenses
    };
}

// ============ DELETE LAST TRANSACTION (for /cancel) ============

async function deleteLastTransaction(userId) {
    const client = getDB();

    // Find the most recent transaction
    const result = await client.execute({
        sql: `SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
        args: [userId]
    });

    if (!result.rows[0]) return null;

    const tx = result.rows[0];

    // Delete it
    await client.execute({
        sql: `DELETE FROM transactions WHERE id = ?`,
        args: [tx.id]
    });

    return tx;
}

// ============ EDIT / DELETE SPECIFIC TRANSACTION ============

async function updateTransaction(transactionId, userId, updates) {
    const client = getDB();
    const fields = [];
    const args = [];

    for (const [key, value] of Object.entries(updates)) {
        if (['amount', 'description', 'category', 'type', 'date', 'payment_method'].includes(key)) {
            fields.push(`${key} = ?`);
            args.push(value);
        }
    }

    if (fields.length === 0) return null;

    args.push(transactionId, userId);

    await client.execute({
        sql: `UPDATE transactions SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
        args
    });

    const result = await client.execute({
        sql: 'SELECT * FROM transactions WHERE id = ? AND user_id = ?',
        args: [transactionId, userId]
    });
    return result.rows[0] || null;
}

async function deleteTransaction(transactionId, userId) {
    const client = getDB();

    const result = await client.execute({
        sql: 'SELECT * FROM transactions WHERE id = ? AND user_id = ?',
        args: [transactionId, userId]
    });

    if (!result.rows[0]) return null;
    const tx = result.rows[0];

    await client.execute({
        sql: 'DELETE FROM transactions WHERE id = ? AND user_id = ?',
        args: [transactionId, userId]
    });

    return tx;
}

async function findTransactionByContext(userId, filters) {
    const client = getDB();
    let sql = 'SELECT * FROM transactions WHERE user_id = ?';
    const args = [userId];

    if (filters.date) {
        sql += ' AND date = ?';
        args.push(filters.date);
    }
    if (filters.category) {
        sql += ' AND LOWER(category) LIKE ?';
        args.push(`%${filters.category.toLowerCase()}%`);
    }
    if (filters.description) {
        sql += ' AND LOWER(description) LIKE ?';
        args.push(`%${filters.description.toLowerCase()}%`);
    }
    if (filters.amount) {
        sql += ' AND amount = ?';
        args.push(filters.amount);
    }
    if (filters.type) {
        sql += ' AND type = ?';
        args.push(filters.type);
    }

    sql += ' ORDER BY date DESC, created_at DESC LIMIT 5';

    const result = await client.execute({ sql, args });
    return result.rows;
}

// ============ ADMIN ANALYTICS QUERIES ============

async function isAdmin(telegramId) {
    if (!telegramId) return false;
    
    // 1. Check Master Admin
    if (String(telegramId) === String(process.env.MASTER_ADMIN_ID)) {
        return true;
    }

    // 2. Check Database
    const client = getDB();
    const result = await client.execute({
        sql: 'SELECT telegram_id FROM admins WHERE telegram_id = ?',
        args: [String(telegramId)]
    });

    return result.rows.length > 0;
}

async function addAdmin(telegramId, addedBy) {
    const client = getDB();
    await client.execute({
        sql: 'INSERT INTO admins (telegram_id, added_by) VALUES (?, ?)',
        args: [String(telegramId), String(addedBy)]
    });
}

async function removeAdmin(telegramId) {
    const client = getDB();
    await client.execute({
        sql: 'DELETE FROM admins WHERE telegram_id = ?',
        args: [String(telegramId)]
    });
}

async function getAllAdmins() {
    const client = getDB();
    const result = await client.execute('SELECT * FROM admins ORDER BY created_at ASC');
    return result.rows;
}

async function getAdminSettings(telegramId) {
    const client = getDB();
    const result = await client.execute({
        sql: 'SELECT notify_preference FROM admins WHERE telegram_id = ?',
        args: [String(telegramId)]
    });
    return result.rows[0] ? result.rows[0].notify_preference : 1; // Default to realtime
}

async function updateAdminSettings(telegramId, preference) {
    const client = getDB();
    await client.execute({
        sql: 'UPDATE admins SET notify_preference = ? WHERE telegram_id = ?',
        args: [preference, String(telegramId)]
    });
}

async function getAdminsForRealtimeNotifs() {
    const client = getDB();
    const result = await client.execute('SELECT telegram_id FROM admins WHERE notify_preference = 1');
    return result.rows.map(r => r.telegram_id);
}

async function getAdminStats() {
    const client = getDB();

    // 1. User metrics
    const usersResult = await client.execute('SELECT COUNT(*) as total FROM users');
    const premiumResult = await client.execute('SELECT COUNT(*) as premium FROM users WHERE is_premium = 1');
    const langResult = await client.execute('SELECT language, COUNT(*) as count FROM users GROUP BY language');
    
    // Get top locations
    const locationResult = await client.execute('SELECT location, COUNT(*) as count FROM users WHERE location IS NOT NULL GROUP BY location ORDER BY count DESC LIMIT 5');

    // 2. Transaction metrics
    const txResult = await client.execute('SELECT COUNT(*) as total FROM transactions');
    const todayTxResult = await client.execute(`SELECT COUNT(*) as total FROM transactions WHERE date = date('now')`);
    const sourceResult = await client.execute('SELECT source, COUNT(*) as count FROM transactions GROUP BY source');
    
    // 3. Peak activity time (busiest hour of day, UTC)
    const timeResult = await client.execute(`
        SELECT strftime('%H', created_at) as hour, COUNT(*) as count 
        FROM transactions 
        GROUP BY hour 
        ORDER BY count DESC 
        LIMIT 1
    `);

    // Format output
    return {
        users: {
            total: Number(usersResult.rows[0]?.total || 0),
            premium: Number(premiumResult.rows[0]?.premium || 0),
            languages: langResult.rows.map(r => ({ lang: r.language, count: Number(r.count) })),
            top_locations: locationResult.rows.map(r => ({ location: r.location, count: Number(r.count) }))
        },
        transactions: {
            total: Number(txResult.rows[0]?.total || 0),
            today: Number(todayTxResult.rows[0]?.total || 0),
            sources: sourceResult.rows.map(r => ({ source: r.source, count: Number(r.count) })),
            peak_hour_utc: timeResult.rows[0]?.hour || null
        }
    };
}

// ============ HEALTH REPORT QUERIES ============

async function saveHealthReport(userId, weekStart, weekEnd, reportJson) {
    const client = getDB();
    const result = await client.execute({
        sql: `INSERT INTO health_reports (user_id, week_start, week_end, report_json)
              VALUES (?, ?, ?, ?) RETURNING *`,
        args: [userId, weekStart, weekEnd, JSON.stringify(reportJson)]
    });
    return result.rows[0];
}

async function getLatestReport(userId) {
    const client = getDB();
    const result = await client.execute({
        sql: `SELECT * FROM health_reports WHERE user_id = ? ORDER BY week_end DESC LIMIT 1`,
        args: [userId]
    });
    return result.rows[0] || null;
}

async function getAllUsers() {
    const client = getDB();
    const result = await client.execute('SELECT * FROM users WHERE onboarding_step = ?', ['complete']);
    return result.rows;
}

// ============ RATE LIMITING & PREMIUM ============

const FREE_DAILY_LIMIT = 10;

/**
 * Check if a user can send a message and increment their daily counter.
 * Premium users are never blocked.
 */
async function checkAndIncrementUsage(userId) {
    const client = getDB();
    const today = new Date().toISOString().split('T')[0];

    const result = await client.execute({
        sql: 'SELECT is_premium, premium_expires_at, daily_msg_count, last_msg_date FROM users WHERE id = ?',
        args: [userId]
    });

    const u = result.rows[0];
    if (!u) return { allowed: false };

    // Check premium status (active = flag set AND not expired)
    const isPremium = Number(u.is_premium) === 1 &&
        (!u.premium_expires_at || new Date(u.premium_expires_at) > new Date());

    const isNewDay = u.last_msg_date !== today;
    const currentCount = isNewDay ? 0 : Number(u.daily_msg_count || 0);

    // Reset counter on new day, or increment
    if (isNewDay) {
        await client.execute({
            sql: 'UPDATE users SET daily_msg_count = 1, last_msg_date = ? WHERE id = ?',
            args: [today, userId]
        });
    } else {
        await client.execute({
            sql: 'UPDATE users SET daily_msg_count = daily_msg_count + 1 WHERE id = ?',
            args: [userId]
        });
    }

    if (isPremium) {
        return { allowed: true, isPremium: true, used: currentCount + 1, limit: Infinity };
    }

    // Free tier — enforce limit
    if (currentCount >= FREE_DAILY_LIMIT) {
        return { allowed: false, isPremium: false, used: currentCount, limit: FREE_DAILY_LIMIT };
    }

    return {
        allowed: true,
        isPremium: false,
        used: currentCount + 1,
        limit: FREE_DAILY_LIMIT,
        remaining: FREE_DAILY_LIMIT - currentCount - 1
    };
}

/**
 * Activate premium for a user.
 * @param {string} telegramId
 * @param {number} months — number of months to grant
 */
async function setPremium(telegramId, months) {
    const client = getDB();
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + months);

    await client.execute({
        sql: `UPDATE users SET is_premium = 1, premium_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?`,
        args: [expiresAt.toISOString(), String(telegramId)]
    });
}

/**
 * Revoke premium.
 */
async function revokePremium(telegramId) {
    const client = getDB();
    await client.execute({
        sql: `UPDATE users SET is_premium = 0, premium_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?`,
        args: [String(telegramId)]
    });
}

// ============ BROADCAST TRACKING ============

async function createBroadcast(summary, adminId) {
    const client = getDB();
    const result = await client.execute({
        sql: 'INSERT INTO broadcasts (summary, admin_id) VALUES (?, ?)',
        args: [String(summary), String(adminId)]
    });
    return result.lastInsertRowid;
}

async function logBroadcastMessage(broadcastId, telegramId, messageId) {
    const client = getDB();
    await client.execute({
        sql: 'INSERT INTO broadcast_logs (broadcast_id, telegram_id, message_id) VALUES (?, ?, ?)',
        args: [broadcastId, String(telegramId), messageId]
    });
}

async function getBroadcastLogs(broadcastId, telegramId = null) {
    const client = getDB();
    if (telegramId) {
        const result = await client.execute({
            sql: 'SELECT telegram_id, message_id FROM broadcast_logs WHERE broadcast_id = ? AND telegram_id = ?',
            args: [broadcastId, String(telegramId)]
        });
        return result.rows;
    } else {
        const result = await client.execute({
            sql: 'SELECT telegram_id, message_id FROM broadcast_logs WHERE broadcast_id = ?',
            args: [broadcastId]
        });
        return result.rows;
    }
}

async function getRecentBroadcasts(limit = 10) {
    const client = getDB();
    const result = await client.execute({
        sql: 'SELECT id, summary, admin_id, created_at, is_deleted FROM broadcasts ORDER BY created_at DESC LIMIT ?',
        args: [limit]
    });
    return result.rows;
}

async function markBroadcastDeleted(broadcastId) {
    const client = getDB();
    await client.execute({
        sql: 'UPDATE broadcasts SET is_deleted = 1 WHERE id = ?',
        args: [broadcastId]
    });
}

module.exports = {
    getDB,
    initDB,
    findUserByTelegramId,
    createUser,
    updateUser,
    saveTransaction,
    saveMultipleTransactions,
    getTransactions,
    getWeeklySummary,
    getLifetimeSummary,
    deleteLastTransaction,
    updateTransaction,
    deleteTransaction,
    findTransactionByContext,
    getAdminStats,
    isAdmin,
    addAdmin,
    removeAdmin,
    getAllAdmins,
    getAdminSettings,
    updateAdminSettings,
    getAdminsForRealtimeNotifs,
    saveHealthReport,
    getLatestReport,
    getAllUsers,
    checkAndIncrementUsage,
    setPremium,
    revokePremium,
    createBroadcast,
    logBroadcastMessage,
    getBroadcastLogs,
    getRecentBroadcasts,
    markBroadcastDeleted,
    blockUser,
    unblockUser,
    FREE_DAILY_LIMIT
};
