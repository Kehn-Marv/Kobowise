require('dotenv').config();
const express = require('express');

// ---------- Prevent crashes from transient network errors ----------
process.on('unhandledRejection', (err) => {
    console.error('⚠️  Unhandled rejection (not crashing):', err?.message || err);
});

process.on('uncaughtException', (err) => {
    // Only crash on truly fatal errors, not network blips
    if (err.code === 'EFATAL' || err.code === 'ENOTFOUND' || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
        console.error('⚠️  Network error (recovering):', err.message);
        return; // Don't crash
    }
    console.error('❌ Uncaught exception:', err);
    process.exit(1);
});
const path = require('path');
const { initDB } = require('./db/schema');
const { initBot } = require('./bot/telegram');
const { startAdminBot } = require('./bot/admin');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Middleware ----------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- API Routes ----------
app.use('/api', apiRoutes);

// ---------- SPA Fallback ----------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ---------- Start ----------
async function start() {
    try {
        // Initialize database (retry up to 3 times)
        let dbReady = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await initDB();
                console.log('✅ Database initialized');
                dbReady = true;
                break;
            } catch (dbErr) {
                console.error(`⚠️  DB init attempt ${attempt}/3 failed:`, dbErr.message);
                if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
            }
        }
        if (!dbReady) {
            console.error('❌ Could not connect to database after 3 attempts. Check your TURSO_DATABASE_URL and internet connection.');
            process.exit(1);
        }

        // Initialize Telegram bot (only if token is set)
        if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN !== 'your_telegram_bot_token_here') {
            initBot();
            console.log('✅ Telegram main bot started');
        } else {
            console.log('⚠️  Telegram main bot skipped (no token set in .env)');
        }

        // Initialize Admin bot
        if (process.env.ADMIN_BOT_TOKEN && process.env.ADMIN_BOT_TOKEN !== 'your_admin_bot_token_here') {
            startAdminBot();
            console.log('✅ Telegram admin bot started');
        } else {
            console.log('⚠️  Telegram admin bot skipped (no token set in .env)');
        }

        // Start server
        app.listen(PORT, () => {
            console.log(`\n🩺 Kobowise is running!`);
            console.log(`   Landing page: http://localhost:${PORT}`);
            console.log(`   Dashboard:    http://localhost:${PORT}/dashboard.html`);
            console.log(`   API:          http://localhost:${PORT}/api\n`);
        });
    } catch (err) {
        console.error('❌ Failed to start:', err.message);
        process.exit(1);
    }
}

start();
