const express = require('express');
const router = express.Router();
const { findUserByTelegramId, getTransactions, getWeeklySummary, getLatestReport } = require('../db/schema');
const { getWeekRange, getPreviousWeekRange } = require('../utils/helpers');

// ============ GET /api/health ============
router.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'kobowise', timestamp: new Date().toISOString() });
});

// ============ GET /api/dashboard?telegram_id=X ============
router.get('/dashboard', async (req, res) => {
    try {
        const telegramId = req.query.telegram_id;
        if (!telegramId) {
            return res.status(400).json({ error: 'telegram_id is required' });
        }

        const user = await findUserByTelegramId(telegramId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const { weekStart, weekEnd } = getWeekRange();
        const summary = await getWeeklySummary(user.id, weekStart, weekEnd);
        const transactions = await getTransactions(user.id, { limit: 50 });
        const report = await getLatestReport(user.id);

        // Previous week for comparison
        const prevRange = getPreviousWeekRange();
        const prevSummary = await getWeeklySummary(user.id, prevRange.weekStart, prevRange.weekEnd);

        // Calculate changes
        const revenueChange = prevSummary.revenue > 0
            ? Math.round(((summary.revenue - prevSummary.revenue) / prevSummary.revenue) * 100)
            : 0;
        const expenseChange = prevSummary.expenses > 0
            ? Math.round(((summary.expenses - prevSummary.expenses) / prevSummary.expenses) * 100)
            : 0;

        res.json({
            user: {
                business_name: user.business_name,
                business_type: user.business_type,
                initials: user.business_name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
            },
            summary: {
                revenue: summary.revenue,
                expenses: summary.expenses,
                profit: summary.profit,
                margin: summary.margin,
                revenue_change: revenueChange,
                expense_change: expenseChange,
                transaction_count: summary.transaction_count
            },
            transactions: transactions.map(tx => ({
                id: tx.id,
                date: tx.date,
                desc: tx.description,
                category: tx.category,
                type: tx.type,
                amount: Number(tx.amount)
            })),
            report: report ? JSON.parse(report.report_json) : null,
            week: { start: weekStart, end: weekEnd }
        });
    } catch (err) {
        console.error('Dashboard API error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============ GET /api/transactions?telegram_id=X ============
router.get('/transactions', async (req, res) => {
    try {
        const telegramId = req.query.telegram_id;
        if (!telegramId) {
            return res.status(400).json({ error: 'telegram_id is required' });
        }

        const user = await findUserByTelegramId(telegramId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const options = {
            limit: parseInt(req.query.limit) || 100,
            type: req.query.type !== 'all' ? req.query.type : undefined,
            category: req.query.category !== 'all' ? req.query.category : undefined,
            startDate: req.query.start_date,
            endDate: req.query.end_date
        };

        const transactions = await getTransactions(user.id, options);

        res.json({
            transactions: transactions.map(tx => ({
                id: tx.id,
                date: tx.date,
                desc: tx.description,
                category: tx.category,
                type: tx.type,
                amount: Number(tx.amount)
            }))
        });
    } catch (err) {
        console.error('Transactions API error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============ GET /api/summary?telegram_id=X ============
router.get('/summary', async (req, res) => {
    try {
        const telegramId = req.query.telegram_id;
        if (!telegramId) {
            return res.status(400).json({ error: 'telegram_id is required' });
        }

        const user = await findUserByTelegramId(telegramId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const { weekStart, weekEnd } = getWeekRange();
        const summary = await getWeeklySummary(user.id, weekStart, weekEnd);

        res.json(summary);
    } catch (err) {
        console.error('Summary API error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============ POST /api/admin/premium ============
// Body: { telegram_id: "...", months: 1 }
// Header: x-admin-secret: <ADMIN_SECRET from .env>
router.post('/admin/premium', async (req, res) => {
    try {
        const adminSecret = process.env.ADMIN_SECRET || 'kobowise-admin-2026';
        if (req.headers['x-admin-secret'] !== adminSecret) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { telegram_id, months } = req.body;
        if (!telegram_id || !months) {
            return res.status(400).json({ error: 'telegram_id and months are required' });
        }

        const { setPremium } = require('../db/schema');
        await setPremium(telegram_id, parseInt(months));

        const user = await findUserByTelegramId(telegram_id);
        res.json({
            success: true,
            user: user?.business_name,
            premium_until: user?.premium_expires_at
        });
    } catch (err) {
        console.error('Admin premium error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============ DELETE /api/admin/premium ============
// Body: { telegram_id: "..." }
router.delete('/admin/premium', async (req, res) => {
    try {
        const adminSecret = process.env.ADMIN_SECRET || 'kobowise-admin-2026';
        if (req.headers['x-admin-secret'] !== adminSecret) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { telegram_id } = req.body;
        if (!telegram_id) {
            return res.status(400).json({ error: 'telegram_id is required' });
        }

        const { revokePremium } = require('../db/schema');
        await revokePremium(telegram_id);

        res.json({ success: true, message: 'Premium revoked' });
    } catch (err) {
        console.error('Admin premium revoke error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
