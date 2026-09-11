const TelegramBot = require('node-telegram-bot-api');
const https = require('https');
const http = require('http');
const { findUserByTelegramId, createUser, updateUser, saveMultipleTransactions, getWeeklySummary, saveHealthReport, getLatestReport, getAllUsers, checkAndIncrementUsage, FREE_DAILY_LIMIT, getTransactions, getLifetimeSummary, deleteLastTransaction, updateTransaction, deleteTransaction, findTransactionByContext } = require('../db/schema');
const { processTextInput, processImage, processVoiceNote, processDocument, processImagePDF, generateHealthReport } = require('../ai/processor');
const { formatNaira, getWeekRange, getPreviousWeekRange } = require('../utils/helpers');
const { extractTextFromDoc, isSupportedDocFormat } = require('../utils/doc-parser');
const { PasswordRequiredError } = require('../utils/pdf-parser');

let bot = null;

// In-memory state for pending edits/clarifications (keyed by telegram_id)
const pendingActions = new Map();

// In-memory state for batching media groups (keyed by media_group_id)
const mediaGroups = new Map();

function initBot(app, webhookUrl) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');

    if (webhookUrl) {
        bot = new TelegramBot(token);
        const url = `${webhookUrl}/api/bot/main`;
        bot.setWebHook(url).catch(err => console.error('Main Bot Webhook Error:', err.message));
        if (app) {
            app.post('/api/bot/main', (req, res) => {
                bot.processUpdate(req.body);
                res.sendStatus(200);
            });
        }
        console.log(`🤖 Telegram bot initialized with Webhook: ${url}`);
    } else {
        bot = new TelegramBot(token, { polling: true });
        console.log('🤖 Telegram bot is listening via Polling...');
    }

    // Register handlers
    bot.onText(/\/start/, handleStart);
    bot.onText(/\/report/, handleReportCommand);
    bot.onText(/\/help/, handleHelp);
    bot.onText(/\/premium/, handlePremium);
    bot.onText(/\/status/, handleStatus);
    bot.onText(/\/balance/, handleBalance);
    bot.onText(/\/settings/, handleSettings);
    bot.onText(/\/export/, handleExport);
    bot.onText(/\/cancel/, handleCancel);
    bot.on('callback_query', handleCallbackQuery);
    bot.on('voice', handleVoice);
    bot.on('photo', handlePhoto);
    bot.on('document', handleDocument);
    bot.on('text', handleText);

    // Handle polling errors gracefully
    bot.on('polling_error', (err) => {
        console.error('⚠️  Telegram polling error:', err.code || '', err.message);
    });

    bot.on('error', (err) => {
        console.error('⚠️  Telegram bot error:', err.code || '', err.message);
    });

    // Schedule weekly reports (every Sunday at 6 PM WAT)
    scheduleWeeklyReports();

    return bot;
}

/**
 * Safe wrapper for bot.sendMessage — catches network errors gracefully
 */
async function safeSend(chatId, text, options) {
    try {
        return await bot.sendMessage(chatId, text, options);
    } catch (err) {
        console.error('⚠️  Failed to send message:', err.message);
        return null;
    }
}

// ============ RATE LIMIT CHECK ============
/**
 * Returns null if allowed, or a message string to send if blocked.
 */
async function enforceRateLimit(user) {
    if (Number(user.is_blocked) === 1) {
        return `🚫 *Account Suspended*\n\nYour account has been restricted by an administrator. Please contact support if you believe this is a mistake.`;
    }

    const usage = await checkAndIncrementUsage(user.id);

    if (!usage.allowed) {
        return `⏳ *Daily limit reached!*\n\nYou've used all ${FREE_DAILY_LIMIT} free messages for today.\n\n🌟 *Upgrade to Premium* for unlimited messages, daily reports, and advanced insights!\n\nSend /premium to learn more.\n\n_Your limit resets at midnight._`;
    }

    // Show a friendly reminder when getting close (at 7, 8, 9)
    if (!usage.isPremium && usage.remaining !== undefined && usage.remaining <= 3 && usage.remaining > 0) {
        return { warning: `\n\n⏱️ _${usage.remaining} free message${usage.remaining === 1 ? '' : 's'} left today. Send /premium for unlimited._` };
    }

    return null;
}

// ============ /START — ONBOARDING ============
async function handleStart(msg) {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);
    const username = msg.from.username || msg.from.first_name;

    try {
        let user = await findUserByTelegramId(telegramId);

        if (user && user.onboarding_step === 'complete') {
            const plan = Number(user.is_premium) === 1 ? '🌟 Premium' : '🆓 Free';
            await safeSend(chatId,
                `Welcome back! 👋\n\nI remember you — *${user.business_name}*\nPlan: ${plan}\n\nJust send me your daily sales and expenses as usual. Voice notes, photos, or text — I've got you!\n\n📊 /report — Get your health report\n📋 /status — Check your usage\n📤 /export — Download financial reports (PDF & Excel)\n🌟 /premium — Upgrade your plan`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        if (!user) {
            user = await createUser(telegramId, username);
        }

        await updateUser(telegramId, { onboarding_step: 'ask_type' });

        await safeSend(chatId,
            `Welcome to *Kobowise*! 🩺\n\nI'm your *Business Doctor*. I help you understand where your money is going — no accounting needed.\n\nWhat type of business do you run?`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    keyboard: [
                        ['🍲 Food / Restaurant', '👗 Fashion / Tailoring'],
                        ['🏪 Retail / Shop', '✂️ Services'],
                        ['📦 Other']
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            }
        );
    } catch (err) {
        console.error('Start error:', err);
        await safeSend(chatId, '❌ Something went wrong connecting to the database. Please try /start again.');
    }
}

// ============ /HELP ============
async function handleHelp(msg) {
    const chatId = msg.chat.id;
    await safeSend(chatId, 
`🤖 *Kobowise Help Desk*

Here are the commands you can use:
/start - Restart the bot and update settings
/status - Check your current plan and usage
/report - Generate a financial health report
/balance - Quick overview of total revenue & expenses
/export - Download reports (PDF, Excel, Income Statement)
/premium - View and upgrade to the Premium plan
/settings - Change language, notifications, and name
/cancel - Undo your last entry
/help - Show this message

*How to use me:*
Just send me text ("Sold a shoe for 5000"), a voice note, or a photo of a receipt, and I'll automatically track it!

📄 *Upload documents too!*
Send me a PDF bank statement or receipt and I'll extract all transactions automatically — with your sensitive data stripped for privacy.

✏️ *Edit records:*
Just tell me naturally: "Change yesterday's transport to 3000" or "Delete Monday's electricity entry"`, 
    { parse_mode: 'Markdown' });
}

// ============ /PREMIUM ============
async function handlePremium(msg) {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);

    try {
        const user = await findUserByTelegramId(telegramId);
        if (user && Number(user.is_blocked) === 1) return;
        
        const now = new Date();
        const expiresAt = user?.premium_expires_at ? new Date(user.premium_expires_at) : null;
        const hasPremiumFlag = user && Number(user.is_premium) === 1;
        const isPremiumActive = hasPremiumFlag && (!expiresAt || expiresAt > now);
        const hasExpired = hasPremiumFlag && expiresAt && expiresAt <= now;

        if (isPremiumActive) {
            const expiresStr = expiresAt ? expiresAt.toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' }) : 'Never';
            await safeSend(chatId,
                `🌟 *You're on Premium!*\n\nExpires: ${expiresStr}\n\n✅ Unlimited messages/day\n✅ Daily + weekly health reports\n✅ Advanced AI insights & prescriptions\n✅ Full transaction history\n✅ Priority support\n\nThank you for supporting Kobowise! 💛`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        let prefixMsg = `🌟 *KOBOWISE PREMIUM*\n\n`;
        if (hasExpired) {
            const expiredDate = expiresAt.toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' });
            prefixMsg = `⚠️ *Your Premium Subscription Expired*\n_Expired on: ${expiredDate}_\n\nRenew now to regain access to unlimited messages and advanced features!\n\n`;
        }

        await safeSend(chatId,
            `${prefixMsg}━━━━━━━━━━━━━━━━━━\n\n🆓 *Free Plan* (Current)\n• ${FREE_DAILY_LIMIT} messages per day\n• Weekly health reports (Sundays)\n• Basic expense categorization\n\n━━━━━━━━━━━━━━━━━━\n\n🌟 *Premium Plan* — ₦1,500/month\n• ✅ *Unlimited* messages per day\n• ✅ Daily mini-reports + weekly deep reports\n• ✅ Advanced AI insights & prescriptions\n• ✅ Expense trend analysis\n• ✅ Best/worst day identification\n• ✅ Full transaction history\n• ✅ Custom expense categories\n• ✅ Priority support\n\n━━━━━━━━━━━━━━━━━━\n\n💰 *How to Renew/Upgrade*\nPlease transfer exactly *₦1,500* to the official account below:\n\nBank: *Opay*\nAcc Name: *Egemonye Marvellous Kenechukwu*\nAcc No: \`9068539301\`\n\n⚠️ *ANTI-SCAM DISCLAIMER*\nKobowise will NEVER ask you to pay into any other account. The account details listed above are the ONLY verified and official payment channels. Do not send money to any other account.\n\n_Once you have made the transfer, click the button below to submit your receipt!_`,
            { 
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📤 I have made payment (Submit Receipt)', callback_data: 'premium_payment_start' }]
                    ]
                }
            }
        );
    } catch (err) {
        console.error('Premium error:', err);
        await safeSend(chatId, '❌ Could not retrieve premium status at this time. Please try again.');
    }
}

// ============ /STATUS ============
async function handleStatus(msg) {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);

    try {
        const user = await findUserByTelegramId(telegramId);
        if (user && Number(user.is_blocked) === 1) return;
        if (!user || user.onboarding_step !== 'complete') {
            await safeSend(chatId, 'Please complete setup first! Send /start');
            return;
        }

        const now = new Date();
        const expiresAt = user.premium_expires_at ? new Date(user.premium_expires_at) : null;
        const hasPremiumFlag = Number(user.is_premium) === 1;
        const isPremium = hasPremiumFlag && (!expiresAt || expiresAt > now);

        const today = new Date().toISOString().split('T')[0];
        const isNewDay = user.last_msg_date !== today;
        const used = isNewDay ? 0 : Number(user.daily_msg_count || 0);

        const plan = isPremium ? '🌟 Premium' : '🆓 Free';
        const usageBar = isPremium
            ? '∞ Unlimited'
            : `${used}/${FREE_DAILY_LIMIT} messages used today ${'▓'.repeat(Math.min(used, FREE_DAILY_LIMIT))}${'░'.repeat(Math.max(0, FREE_DAILY_LIMIT - used))}`;

        // Get this week's summary
        const { weekStart, weekEnd } = getWeekRange();
        let weekSummary = '';
        try {
            const summary = await getWeeklySummary(user.id, weekStart, weekEnd);
            if (summary.transaction_count > 0) {
                weekSummary = `\n\n📊 *This Week So Far:*\n💰 Revenue: ${formatNaira(summary.revenue)}\n💸 Expenses: ${formatNaira(summary.expenses)}\n📊 Profit: ${formatNaira(summary.profit)}\n📝 Transactions: ${summary.transaction_count}`;
            } else {
                weekSummary = '\n\n📊 _No transactions recorded this week yet._';
            }
        } catch (e) { /* ignore */ }

        await safeSend(chatId,
            `📋 *Account Status*\n\n🏪 Business: *${user.business_name}*\n📦 Type: ${user.business_type}\n💎 Plan: ${plan}\n\n⏱️ *Daily Usage:*\n${usageBar}${weekSummary}\n\n${isPremium ? '✨ _Enjoying premium? Thank you for your support!_' : '💡 _Send /premium to unlock unlimited messages._'}`,
            { parse_mode: 'Markdown' }
        );
    } catch (err) {
        console.error('Status error:', err);
        await safeSend(chatId, '❌ Could not retrieve status. Please try again.');
    }
}

// ============ /REPORT ============
async function handleReportCommand(msg) {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);

    try {
        const user = await findUserByTelegramId(telegramId);
        if (!user || user.onboarding_step !== 'complete') {
            await safeSend(chatId, 'Please complete setup first! Send /start');
            return;
        }

        await safeSend(chatId, '📊 Generating your health report... Give me a moment! 🩺');

        const { weekStart, weekEnd } = getWeekRange();
        const summary = await getWeeklySummary(user.id, weekStart, weekEnd);

        if (summary.transaction_count === 0) {
            await safeSend(chatId,
                '📋 No transactions recorded this week yet!\n\nStart sending me your daily sales and expenses, and I\'ll have a report ready for you by Sunday. 💪'
            );
            return;
        }

        // Get previous week for comparison
        const prevRange = getPreviousWeekRange();
        const prevSummary = await getWeeklySummary(user.id, prevRange.weekStart, prevRange.weekEnd);
        const prevReport = prevSummary.transaction_count > 0 ? prevSummary : null;

        const report = await generateHealthReport(summary, user.business_name, user.business_type, prevReport);

        // Save report
        await saveHealthReport(user.id, weekStart, weekEnd, { ...report, ...summary });

        // Send to user
        await safeSend(chatId, report.telegram_message, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error('Report generation error:', err);
        await safeSend(chatId, '❌ Sorry, something went wrong generating your report. Please try again in a moment.');
    }
}

// ============ /BALANCE ============
async function handleBalance(msg) {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);

    try {
        const user = await findUserByTelegramId(telegramId);
        if (!user || user.onboarding_step !== 'complete') {
            await safeSend(chatId, 'Please complete setup first! Send /start');
            return;
        }

        const summary = await getLifetimeSummary(user.id);

        const profitEmoji = summary.profit >= 0 ? '✅' : '⚠️';
        const todayProfitEmoji = summary.today_profit >= 0 ? '📈' : '📉';
        const marginStr = summary.margin >= 0 ? `${summary.margin}%` : `${summary.margin}%`;

        let balanceMsg = `💰 *${user.business_name} — Balance Overview*\n\n`;
        balanceMsg += `━━━━━━━━━━━━━━━━━━\n\n`;

        // Today's snapshot
        balanceMsg += `📅 *Today:*\n`;
        balanceMsg += `   💰 Revenue: ${formatNaira(summary.today_revenue)}\n`;
        balanceMsg += `   💸 Expenses: ${formatNaira(summary.today_expenses)}\n`;
        balanceMsg += `   ${todayProfitEmoji} Profit: *${formatNaira(summary.today_profit)}*\n\n`;

        balanceMsg += `━━━━━━━━━━━━━━━━━━\n\n`;

        // All-time totals
        balanceMsg += `📊 *All-Time Totals:*\n`;
        balanceMsg += `   💰 Total Revenue: ${formatNaira(summary.revenue)}\n`;
        balanceMsg += `   💸 Total Expenses: ${formatNaira(summary.expenses)}\n`;
        balanceMsg += `   ${profitEmoji} Net Profit: *${formatNaira(summary.profit)}*\n`;
        balanceMsg += `   📐 Profit Margin: *${marginStr}*\n\n`;

        balanceMsg += `📝 Total Entries: ${summary.transaction_count}\n\n`;
        balanceMsg += `_Send /report for a detailed weekly breakdown._`;

        await safeSend(chatId, balanceMsg, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error('Balance error:', err);
        await safeSend(chatId, '❌ Could not retrieve your balance. Please try again.');
    }
}

// ============ /EXPORT — UPGRADED WITH FORMAT OPTIONS ============
async function handleExport(msg) {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);

    try {
        const user = await findUserByTelegramId(telegramId);
        if (!user || user.onboarding_step !== 'complete') {
            await safeSend(chatId, 'Please complete setup first! Send /start');
            return;
        }

        // Show format selection
        await safeSend(chatId,
            `📤 *Export Your Financial Records*\n\n*Choose your format:*`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '📄 Sales & Expense Record (PDF)', callback_data: 'export_pdf' },
                        ],
                        [
                            { text: '📊 Full Workbook (Excel)', callback_data: 'export_excel' },
                        ],
                        [
                            { text: '📋 Income Statement (PDF)', callback_data: 'export_income_stmt' },
                        ],
                    ]
                }
            }
        );
    } catch (err) {
        console.error('Export error:', err);
        await safeSend(chatId, '❌ Could not start export. Please try again.');
    }
}

// ============ /CANCEL ============
async function handleCancel(msg) {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);

    try {
        const user = await findUserByTelegramId(telegramId);
        if (!user) {
            await safeSend(chatId, 'Welcome! Send /start to get set up 🩺');
            return;
        }

        let response = '';

        // 1. Reset onboarding state if stuck mid-flow
        if (user.onboarding_step !== 'complete') {
            await updateUser(telegramId, { onboarding_step: 'complete' });
            response += '🔄 *Conversation state reset.*\n\n';
        }

        // Clear any pending actions
        pendingActions.delete(telegramId);

        // 2. Delete the most recent transaction (undo)
        const deleted = await deleteLastTransaction(user.id);

        if (deleted) {
            const typeEmoji = deleted.type === 'income' ? '💰' : '💸';
            response += `✅ *Last entry deleted:*\n${typeEmoji} ${deleted.description}: ${formatNaira(Number(deleted.amount))} (${deleted.category})\n\n`;
            response += `_Entry from ${deleted.date} has been removed._`;
        } else {
            if (!response) {
                response = '📋 Nothing to cancel — no recent entries found.\n\n_Your transaction history is clean!_';
            } else {
                response += '_No recent transactions to undo._';
            }
        }

        await safeSend(chatId, response, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error('Cancel error:', err);
        await safeSend(chatId, '❌ Something went wrong. Please try again.');
    }
}

// ============ /SETTINGS ============
async function handleSettings(msg) {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);

    try {
        const user = await findUserByTelegramId(telegramId);
        if (!user || user.onboarding_step !== 'complete') {
            await safeSend(chatId, 'Please complete setup first! Send /start');
            return;
        }

        const lang = user.language || 'en';
        const notif = Number(user.notifications_enabled ?? 1) === 1;

        const langLabel = lang === 'en' ? '🇬🇧 English' : '🇳🇬 Pidgin';
        const notifLabel = notif ? '🔔 ON' : '🔕 OFF';

        await safeSend(chatId,
            `⚙️ *Settings for ${user.business_name}*\n\n🗣️ Language: *${langLabel}*\n📢 Weekly Reports: *${notifLabel}*\n🏪 Business Name: *${user.business_name}*\n📦 Business Type: *${user.business_type}*\n\nTap a button below to change:`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: lang === 'en' ? '✅ English' : '🇬🇧 English', callback_data: 'settings_lang_en' },
                            { text: lang === 'pidgin' ? '✅ Pidgin' : '🇳🇬 Pidgin', callback_data: 'settings_lang_pidgin' }
                        ],
                        [
                            { text: notif ? '🔔 Notifications: ON' : '🔕 Notifications: OFF', callback_data: 'settings_notif_toggle' }
                        ],
                        [
                            { text: '✏️ Change Business Name', callback_data: 'settings_rename' }
                        ]
                    ]
                }
            }
        );
    } catch (err) {
        console.error('Settings error:', err);
        await safeSend(chatId, '❌ Could not load settings. Please try again.');
    }
}

// ============ CALLBACK QUERY HANDLER ============
async function handleCallbackQuery(query) {
    const chatId = query.message.chat.id;
    const telegramId = String(query.from.id);
    const data = query.data;

    try {
        const user = await findUserByTelegramId(telegramId);
        if (!user) {
            await bot.answerCallbackQuery(query.id, { text: 'Please /start first!' });
            return;
        }

        // ---- SETTINGS CALLBACKS ----
        if (data === 'settings_lang_en') {
            await updateUser(telegramId, { language: 'en' });
            await bot.answerCallbackQuery(query.id, { text: '🇬🇧 Language set to English!' });
            await handleSettings({ chat: { id: chatId }, from: { id: query.from.id } });
        } else if (data === 'settings_lang_pidgin') {
            await updateUser(telegramId, { language: 'pidgin' });
            await bot.answerCallbackQuery(query.id, { text: '🇳🇬 Language set to Pidgin!' });
            await handleSettings({ chat: { id: chatId }, from: { id: query.from.id } });
        } else if (data === 'settings_notif_toggle') {
            const current = Number(user.notifications_enabled ?? 1);
            const newVal = current === 1 ? 0 : 1;
            await updateUser(telegramId, { notifications_enabled: newVal });
            await bot.answerCallbackQuery(query.id, { text: newVal === 1 ? '🔔 Notifications turned ON!' : '🔕 Notifications turned OFF!' });
            await handleSettings({ chat: { id: chatId }, from: { id: query.from.id } });
        } else if (data === 'settings_rename') {
            await updateUser(telegramId, { onboarding_step: 'ask_name' });
            await bot.answerCallbackQuery(query.id, { text: '✏️ Send your new business name!' });
            await safeSend(chatId, '✏️ What would you like to rename your business to?\n\n_Just type the new name and send it._', { parse_mode: 'Markdown' });
        } else if (data === 'premium_payment_start') {
            await updateUser(telegramId, { onboarding_step: 'awaiting_receipt' });
            await bot.answerCallbackQuery(query.id, { text: '📤 Please upload your receipt photo now.' });
            await safeSend(chatId, '📸 *Upload Payment Receipt*\n\nPlease upload a photo or screenshot of your successful transfer now.\n\nOur team will verify it and activate your Premium instantly!', { parse_mode: 'Markdown' });

        // ---- EXPORT FORMAT CALLBACKS ----
        } else if (data === 'export_pdf' || data === 'export_excel' || data === 'export_income_stmt') {
            // Store the export format, now ask for date range
            pendingActions.set(telegramId, { type: 'export', format: data });
            await bot.answerCallbackQuery(query.id, { text: '📅 Choose date range...' });
            await safeSend(chatId, '📅 *Select date range:*', {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '📅 This Week', callback_data: 'export_range_week' },
                            { text: '📆 This Month', callback_data: 'export_range_month' },
                        ],
                        [
                            { text: '📋 All Time', callback_data: 'export_range_all' },
                        ],
                    ]
                }
            });

        // ---- EXPORT DATE RANGE CALLBACKS ----
        } else if (data.startsWith('export_range_')) {
            const pending = pendingActions.get(telegramId);
            if (!pending || pending.type !== 'export') {
                await bot.answerCallbackQuery(query.id, { text: '❌ Please start again with /export' });
                return;
            }

            await bot.answerCallbackQuery(query.id, { text: '⏳ Generating...' });
            await safeSend(chatId, '⏳ Generating your export file... This may take a moment.');

            const range = data.replace('export_range_', '');
            const format = pending.format;
            pendingActions.delete(telegramId);

            // Calculate date range
            let startDate = null, endDate = null;
            const now = new Date();
            if (range === 'week') {
                const { weekStart, weekEnd } = getWeekRange();
                startDate = weekStart;
                endDate = weekEnd;
            } else if (range === 'month') {
                startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
                endDate = now.toISOString().split('T')[0];
            }
            // 'all' = no date filter

            const txOptions = {};
            if (startDate) txOptions.startDate = startDate;
            if (endDate) txOptions.endDate = endDate;

            const transactions = await getTransactions(user.id, txOptions);

            if (!transactions || transactions.length === 0) {
                await safeSend(chatId, '📋 No transactions found for this period!\n\nStart sending me your sales and expenses and I\'ll have data ready for you.');
                return;
            }

            const { generateProfessionalPDF, generateIncomeStatementPDF, generateExcelWorkbook } = require('../utils/export-generator');

            const totalIncome = transactions.filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amount), 0);
            const totalExpense = transactions.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0);
            const rangeName = range === 'week' ? 'This Week' : range === 'month' ? 'This Month' : 'All Time';

            try {
                if (format === 'export_pdf') {
                    const pdfBuffer = await generateProfessionalPDF(user, transactions);
                    const fileName = `Kobowise_${user.business_name.replace(/[^a-zA-Z0-9]/g, '_')}_Report_${new Date().toISOString().split('T')[0]}.pdf`;
                    await bot.sendDocument(chatId, pdfBuffer, {
                        caption: `📄 *${user.business_name}* — Sales & Expense Record\n\n📅 Period: ${rangeName}\n📝 ${transactions.length} transactions\n💰 Revenue: ${formatNaira(totalIncome)}\n💸 Expenses: ${formatNaira(totalExpense)}\n📈 Profit: ${formatNaira(totalIncome - totalExpense)}`,
                        parse_mode: 'Markdown'
                    }, { filename: fileName, contentType: 'application/pdf' });
                } else if (format === 'export_excel') {
                    const excelBuffer = await generateExcelWorkbook(user, transactions);
                    const fileName = `Kobowise_${user.business_name.replace(/[^a-zA-Z0-9]/g, '_')}_Workbook_${new Date().toISOString().split('T')[0]}.xlsx`;
                    await bot.sendDocument(chatId, excelBuffer, {
                        caption: `📊 *${user.business_name}* — Full Excel Workbook\n\n📅 Period: ${rangeName}\n📝 ${transactions.length} transactions\n\n*Sheets included:*\n• Transactions (full ledger)\n• Income Statement\n• Cash Flow\n• Summary Dashboard\n\n💰 Revenue: ${formatNaira(totalIncome)}\n💸 Expenses: ${formatNaira(totalExpense)}\n📈 Profit: ${formatNaira(totalIncome - totalExpense)}`,
                        parse_mode: 'Markdown'
                    }, { filename: fileName, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                } else if (format === 'export_income_stmt') {
                    const pdfBuffer = await generateIncomeStatementPDF(user, transactions);
                    const fileName = `Kobowise_${user.business_name.replace(/[^a-zA-Z0-9]/g, '_')}_Income_Statement_${new Date().toISOString().split('T')[0]}.pdf`;
                    await bot.sendDocument(chatId, pdfBuffer, {
                        caption: `📋 *${user.business_name}* — Income Statement\n\n📅 Period: ${rangeName}\n💰 Revenue: ${formatNaira(totalIncome)}\n💸 Expenses: ${formatNaira(totalExpense)}\n📈 Net Profit: ${formatNaira(totalIncome - totalExpense)}`,
                        parse_mode: 'Markdown'
                    }, { filename: fileName, contentType: 'application/pdf' });
                }
            } catch (exportErr) {
                console.error('Export generation error:', exportErr);
                await safeSend(chatId, '❌ Failed to generate your export. Please try again.');
            }

        // ---- EDIT CONFIRMATION CALLBACKS ----
        } else if (data === 'confirm_edit_yes') {
            const pending = pendingActions.get(telegramId);
            if (!pending || pending.type !== 'edit') {
                await bot.answerCallbackQuery(query.id, { text: '❌ No pending edit.' });
                return;
            }

            const result = await updateTransaction(pending.transactionId, user.id, pending.updates);
            pendingActions.delete(telegramId);

            if (result) {
                await bot.answerCallbackQuery(query.id, { text: '✅ Updated!' });
                await safeSend(chatId, `✅ *Record updated!*\n\n${pending.summary}`, { parse_mode: 'Markdown' });
            } else {
                await bot.answerCallbackQuery(query.id, { text: '❌ Failed to update.' });
                await safeSend(chatId, '❌ Could not update that record. It may have been deleted.');
            }

        } else if (data === 'confirm_edit_no') {
            pendingActions.delete(telegramId);
            await bot.answerCallbackQuery(query.id, { text: '❌ Cancelled.' });
            await safeSend(chatId, '↩️ Edit cancelled. No changes made.');

        } else if (data === 'confirm_delete_yes') {
            const pending = pendingActions.get(telegramId);
            if (!pending || pending.type !== 'delete') {
                await bot.answerCallbackQuery(query.id, { text: '❌ No pending delete.' });
                return;
            }

            const result = await deleteTransaction(pending.transactionId, user.id);
            pendingActions.delete(telegramId);

            if (result) {
                await bot.answerCallbackQuery(query.id, { text: '🗑️ Deleted!' });
                await safeSend(chatId, `🗑️ *Record deleted!*\n\n${pending.summary}`, { parse_mode: 'Markdown' });
            } else {
                await bot.answerCallbackQuery(query.id, { text: '❌ Failed to delete.' });
                await safeSend(chatId, '❌ Could not delete that record. It may have already been removed.');
            }

        } else if (data === 'confirm_delete_no') {
            pendingActions.delete(telegramId);
            await bot.answerCallbackQuery(query.id, { text: '❌ Cancelled.' });
            await safeSend(chatId, '↩️ Delete cancelled. Record kept.');

        // ---- BANK STATEMENT CONFIRMATION CALLBACKS ----
        } else if (data === 'confirm_bank_yes') {
            const pending = pendingActions.get(telegramId);
            if (!pending || pending.type !== 'bank_confirm') {
                await bot.answerCallbackQuery(query.id, { text: '❌ No pending transactions.' });
                return;
            }

            await bot.answerCallbackQuery(query.id, { text: '⏳ Saving...' });
            const saved = await saveMultipleTransactions(user.id, pending.transactions, 'document');
            pendingActions.delete(telegramId);

            await safeSend(chatId, `✅ *${saved.length} transactions logged from your document!*\n\nSend /balance to see your updated totals, or /export to download your records.`, { parse_mode: 'Markdown' });

        } else if (data === 'confirm_bank_no') {
            pendingActions.delete(telegramId);
            await bot.answerCallbackQuery(query.id, { text: '❌ Discarded.' });
            await safeSend(chatId, '↩️ Document transactions discarded. Nothing was saved.');
            
        // ---- IMAGE PDF CONFIRMATION CALLBACKS ----
        } else if (data === 'confirm_image_pdf_yes') {
            const pending = pendingActions.get(telegramId);
            if (!pending || pending.type !== 'awaiting_image_pdf_confirm') {
                await bot.answerCallbackQuery(query.id, { text: '❌ Invalid state.' });
                return;
            }
            const { fileId } = pending;
            pendingActions.delete(telegramId);
            await bot.answerCallbackQuery(query.id, { text: '⏳ Processing...' });
            
            try {
                const user = await findUserByTelegramId(telegramId);
                await safeSend(chatId, '📄 Processing your scanned document with Gemini Vision...', { parse_mode: 'Markdown' });
                await bot.sendChatAction(chatId, 'typing').catch(() => {});
                
                const file = await bot.getFile(fileId);
                const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
                const fileBuffer = await downloadFile(fileUrl);
                
                const result = await processImagePDF(fileBuffer, user.business_type);
                
                if (result.transactions && result.transactions.length > 0) {
                    let previewMsg = `📄 *Found ${result.transactions.length} transactions from your scanned document:*\n\n`;
                    const incomes = result.transactions.filter(t => t.type === 'income');
                    const expenses = result.transactions.filter(t => t.type === 'expense');
                    const totalIn = incomes.reduce((s, t) => s + Number(t.amount), 0);
                    const totalOut = expenses.reduce((s, t) => s + Number(t.amount), 0);

                    if (incomes.length > 0) previewMsg += `💰 *${incomes.length} credits* totaling ${formatNaira(totalIn)}\n`;
                    if (expenses.length > 0) previewMsg += `💸 *${expenses.length} debits* totaling ${formatNaira(totalOut)}\n`;

                    previewMsg += '\n*Preview:*\n';
                    result.transactions.slice(0, 5).forEach(t => {
                        const emoji = t.type === 'income' ? '💰' : '💸';
                        previewMsg += `${emoji} ${t.date || 'No date'} — ${t.description}: ${formatNaira(t.amount)}\n`;
                    });
                    if (result.transactions.length > 5) previewMsg += `_...and ${result.transactions.length - 5} more_\n`;
                    previewMsg += '\n*Save all these transactions to your records?*';

                    pendingActions.set(telegramId, { type: 'bank_confirm', transactions: result.transactions });

                    await safeSend(chatId, previewMsg, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [ { text: '✅ Yes, save all', callback_data: 'confirm_bank_yes' }, { text: '❌ No, discard', callback_data: 'confirm_bank_no' } ]
                            ]
                        }
                    });
                } else {
                    await safeSend(chatId, `📉 I couldn't find any valid transactions in this document.\n\nSummary: ${result.summary || 'No data found'}`);
                }
            } catch (err) {
                console.error('Image PDF process error:', err);
                await safeSend(chatId, '❌ Something went wrong processing the scanned PDF.');
            }

        } else if (data === 'confirm_image_pdf_no') {
            pendingActions.delete(telegramId);
            await bot.answerCallbackQuery(query.id, { text: '❌ Cancelled.' });
            await safeSend(chatId, '↩️ Cancelled. The document was not processed.');
        }
    } catch (err) {
        console.error('Callback query error:', err);
        await bot.answerCallbackQuery(query.id, { text: '❌ Something went wrong.' }).catch(() => {});
    }
}

// ============ TEXT MESSAGE HANDLER ============
async function handleText(msg) {
    // Skip commands
    if (msg.text?.startsWith('/')) return;

    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);
    const text = msg.text;

    try {
        let user = await findUserByTelegramId(telegramId);

        // Not registered
        if (!user) {
            await safeSend(chatId, 'Welcome! Send /start to get set up 🩺');
            return;
        }

        // Check for pending password
        const pending = pendingActions.get(telegramId);
        if (pending && pending.type === 'awaiting_pdf_password') {
            await processDocumentFile(pending.fileId, pending.mimeType, pending.fileName, chatId, telegramId, user, text);
            return;
        }

        // Onboarding flow (no rate limit during onboarding)
        if (user.onboarding_step !== 'complete') {
            await handleOnboarding(chatId, telegramId, text, user);
            return;
        }

        // Rate limit check
        const rateResult = await enforceRateLimit(user);
        if (rateResult && typeof rateResult === 'string') {
            await safeSend(chatId, rateResult, { parse_mode: 'Markdown' });
            return;
        }
        const usageWarning = rateResult?.warning || '';

        // Regular transaction input
        await bot.sendChatAction(chatId, 'typing').catch(() => {});

        // Fetch recent context for Q&A
        const recentTxs = await getTransactions(user.id, { limit: 50 });
        const contextStr = formatTransactionContext(recentTxs);

        const result = await processTextInput(text, user.business_type, contextStr);

        // Handle different action types
        await handleAIResponse(chatId, telegramId, user, result, 'text', usageWarning);
    } catch (err) {
        console.error('Text processing error:', err);
        if (err.message.includes('GEMINI_API_KEY')) {
            await safeSend(chatId, '⚠️ AI is not configured yet. The admin needs to set up the GEMINI_API_KEY.');
        } else {
            await safeSend(chatId, '❌ Sorry, I didn\'t quite catch that. Try sending a voice note, or type /help to see my commands.');
        }
    }
}

// ============ VOICE NOTE HANDLER ============
async function handleVoice(msg) {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);

    try {
        const user = await findUserByTelegramId(telegramId);
        if (!user || user.onboarding_step !== 'complete') {
            await safeSend(chatId, 'Please complete setup first! Send /start');
            return;
        }

        // Rate limit check
        const rateResult = await enforceRateLimit(user);
        if (rateResult && typeof rateResult === 'string') {
            await safeSend(chatId, rateResult, { parse_mode: 'Markdown' });
            return;
        }
        const usageWarning = rateResult?.warning || '';

        await safeSend(chatId, '🎧 Listening to your voice note...');
        await bot.sendChatAction(chatId, 'typing').catch(() => {});

        // Download voice file from Telegram
        const fileId = msg.voice.file_id;
        const file = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const audioBuffer = await downloadFile(fileUrl);

        // Fetch recent context for Q&A
        const recentTxs = await getTransactions(user.id, { limit: 50 });
        const contextStr = formatTransactionContext(recentTxs);

        // Process with Gemini (native audio support)
        const result = await processVoiceNote(audioBuffer, 'audio/ogg', user.business_type, contextStr);

        await handleAIResponse(chatId, telegramId, user, result, 'voice', usageWarning);
    } catch (err) {
        console.error('Voice processing error:', err);
        await safeSend(chatId, '❌ Sorry, I couldn\'t process your voice note. Try speaking a bit clearer, type it out, or send /help to see my commands.');
    }
}

// ============ MEDIA GROUP PROCESSOR ============
async function processMediaGroup(groupId, user) {
    const group = mediaGroups.get(groupId);
    if (!group) return;
    mediaGroups.delete(groupId); // Clean up immediately

    const { chatId, telegramId, items } = group;

    try {
        await safeSend(chatId, `📸 Processing ${items.length} photo(s)...`);
        await bot.sendChatAction(chatId, 'typing').catch(() => {});

        const images = [];
        for (const msg of items) {
            const photo = msg.photo[msg.photo.length - 1];
            const file = await bot.getFile(photo.file_id);
            const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
            const buffer = await downloadFile(fileUrl);
            const mimeType = file.file_path.endsWith('.png') ? 'image/png' : 'image/jpeg';
            images.push({ buffer, mimeType });
        }

        const recentTxs = await getTransactions(user.id, { limit: 50 });
        const contextStr = formatTransactionContext(recentTxs);

        // Process all images at once
        const result = await processImage(images, user.business_type, contextStr);
        await handleAIResponse(chatId, telegramId, user, result, 'photo', group.usageWarning || '');
    } catch (err) {
        console.error('Media group processing error:', err);
        await safeSend(chatId, '❌ Sorry, I couldn\'t process those photos. Please try again.');
    }
}

// ============ PHOTO HANDLER ============
async function handlePhoto(msg) {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);

    try {
        const user = await findUserByTelegramId(telegramId);
        
        if (user && user.onboarding_step === 'awaiting_receipt') {
            // Forward photo to Admin Bot
            await safeSend(chatId, '✅ *Receipt Submitted!*\n\nOur team is verifying your payment. Your premium will be activated shortly.', { parse_mode: 'Markdown' });
            await updateUser(telegramId, { onboarding_step: 'complete' });
            try {
                const { forwardPremiumReceipt } = require('./admin');
                const photo = msg.photo[msg.photo.length - 1]; 
                const fileUrl = await bot.getFileLink(photo.file_id);
                const response = await fetch(fileUrl);
                const buffer = Buffer.from(await response.arrayBuffer());
                await forwardPremiumReceipt(user.id, user.business_name, user.telegram_username, user.telegram_id, buffer);
            } catch (e) { console.error("Failed to forward receipt", e); }
            return;
        }

        if (!user || user.onboarding_step !== 'complete') {
            await safeSend(chatId, 'Please complete setup first! Send /start');
            return;
        }

        const rateResult = await enforceRateLimit(user);
        if (rateResult && typeof rateResult === 'string') {
            await safeSend(chatId, rateResult, { parse_mode: 'Markdown' });
            return;
        }
        const usageWarning = rateResult?.warning || '';

        const groupId = msg.media_group_id;
        
        if (groupId) {
            if (!mediaGroups.has(groupId)) {
                mediaGroups.set(groupId, { items: [], timer: null, chatId, telegramId, usageWarning });
                await safeSend(chatId, '📥 Receiving multiple files... This might take several seconds.');
            }
            
            const group = mediaGroups.get(groupId);
            
            if (group.items.length >= 10) {
                // Drop extras to prevent abuse
                return;
            }
            
            group.items.push(msg);
            clearTimeout(group.timer);
            
            // Wait 3 seconds for all items in the group to arrive
            group.timer = setTimeout(() => processMediaGroup(groupId, user), 3000);
            return;
        }

        // Single photo handling (simulate a group of 1)
        mediaGroups.set('single_' + msg.message_id, { items: [msg], timer: null, chatId, telegramId, usageWarning });
        await processMediaGroup('single_' + msg.message_id, user);

    } catch (err) {
        console.error('Photo processing error:', err);
        await safeSend(chatId, '❌ Sorry, I couldn\'t read your photo.');
    }
}

// ============ PROCESS DOCUMENT FILE ============
async function processDocumentFile(fileId, mimeType, fileName, chatId, telegramId, user, password = null) {
    try {
        await safeSend(chatId, '📄 Processing your document...\n🔒 _Extracting data..._', { parse_mode: 'Markdown' });
        await bot.sendChatAction(chatId, 'typing').catch(() => {});

        const file = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const fileBuffer = await downloadFile(fileUrl);

        let extractedText = '';
        let isBank = false;
        let isImagePdf = false;

        if (fileName.endsWith('.pdf') || mimeType.includes('pdf')) {
            const { extractTextFromPDF, stripSensitiveData, isBankStatement } = require('../utils/pdf-parser');
            try {
                const parseResult = await extractTextFromPDF(fileBuffer, password);
                extractedText = parseResult.text;
                isImagePdf = parseResult.isImageOnly;
            } catch (pdfErr) {
                if (pdfErr.name === 'PasswordRequiredError') {
                    pendingActions.set(telegramId, {
                        type: 'awaiting_pdf_password',
                        fileId, mimeType, fileName,
                        attempts: (pendingActions.get(telegramId)?.attempts || 0) + 1
                    });
                    
                    if (pendingActions.get(telegramId).attempts > 3) {
                        pendingActions.delete(telegramId);
                        await safeSend(chatId, '❌ Too many incorrect password attempts. Process cancelled.');
                        return;
                    }
                    
                    await safeSend(chatId, '🔒 *This PDF is password-protected.*\n\nPlease reply with the password to unlock it.', { parse_mode: 'Markdown' });
                    return;
                }
                await safeSend(chatId, `❌ ${pdfErr.message}\n\nIf this is a bank statement, try:\n1. Download it again from your app\n2. Try taking a screenshot instead and sending it as a photo 📸`);
                return;
            }

            if (isImagePdf) {
                // Ask for confirmation before sending raw PDF to Gemini
                pendingActions.set(telegramId, {
                    type: 'awaiting_image_pdf_confirm',
                    fileId, mimeType, fileName
                });
                await safeSend(chatId, '⚠️ *Scanned Document Detected*\n\nThis PDF appears to be a scanned image (no text layer). Because it is an image, I *cannot automatically redact sensitive info* (like account numbers) before processing.\n\nDo you want me to proceed anyway?', {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [ { text: '✅ Yes, proceed', callback_data: 'confirm_image_pdf_yes' } ],
                            [ { text: '❌ Cancel', callback_data: 'confirm_image_pdf_no' } ]
                        ]
                    }
                });
                return;
            }

            extractedText = stripSensitiveData(extractedText);
            isBank = isBankStatement(extractedText);
            if (isBank) {
                await safeSend(chatId, '🏦 _Bank statement detected! Extracting transactions..._', { parse_mode: 'Markdown' });
            }
        } else if (isSupportedDocFormat(mimeType, fileName)) {
            extractedText = await extractTextFromDoc(fileBuffer, mimeType);
        } else {
            await safeSend(chatId, '❌ Unsupported document format. Please send a PDF, DOCX, TXT, or CSV.');
            return;
        }

        if (!extractedText || extractedText.trim().length < 10) {
            await safeSend(chatId, '❌ This document appears to be empty or unreadable.');
            return;
        }

        // Process with AI
        const result = await processDocument(extractedText, user.business_type);

        if (result.transactions && result.transactions.length > 0) {
            let previewMsg = `📄 *Found ${result.transactions.length} transactions${isBank ? ' from your bank statement' : ''}:*\n\n`;
            const incomes = result.transactions.filter(t => t.type === 'income');
            const expenses = result.transactions.filter(t => t.type === 'expense');
            const totalIn = incomes.reduce((s, t) => s + Number(t.amount), 0);
            const totalOut = expenses.reduce((s, t) => s + Number(t.amount), 0);

            if (incomes.length > 0) previewMsg += `💰 *${incomes.length} credits* totaling ${formatNaira(totalIn)}\n`;
            if (expenses.length > 0) previewMsg += `💸 *${expenses.length} debits* totaling ${formatNaira(totalOut)}\n`;

            previewMsg += '\n*Preview:*\n';
            result.transactions.slice(0, 5).forEach(t => {
                const emoji = t.type === 'income' ? '💰' : '💸';
                previewMsg += `${emoji} ${t.date || 'No date'} — ${t.description}: ${formatNaira(t.amount)}\n`;
            });
            if (result.transactions.length > 5) previewMsg += `_...and ${result.transactions.length - 5} more_\n`;
            previewMsg += '\n*Save all these transactions to your records?*';

            pendingActions.set(telegramId, { type: 'bank_confirm', transactions: result.transactions });

            await safeSend(chatId, previewMsg, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Yes, save all', callback_data: 'confirm_bank_yes' },
                            { text: '❌ No, discard', callback_data: 'confirm_bank_no' },
                        ]
                    ]
                }
            });
        } else {
            await safeSend(chatId, result.summary || '📄 I couldn\'t find any transactions in this document. Make sure it\'s a bank statement or financial record.');
        }
    } catch (err) {
        console.error('Document processing error:', err);
        await safeSend(chatId, '❌ Sorry, something went wrong processing your document. Please try again.');
    }
}

// ============ DOCUMENT HANDLER ============
async function handleDocument(msg) {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);

    try {
        const user = await findUserByTelegramId(telegramId);
        if (!user || user.onboarding_step !== 'complete') {
            await safeSend(chatId, 'Please complete setup first! Send /start');
            return;
        }

        const rateResult = await enforceRateLimit(user);
        if (rateResult && typeof rateResult === 'string') {
            await safeSend(chatId, rateResult, { parse_mode: 'Markdown' });
            return;
        }

        const doc = msg.document;
        const fileName = (doc.file_name || '').toLowerCase();
        const mimeType = doc.mime_type || '';

        const { isSupportedDocFormat } = require('../utils/doc-parser');
        if (!isSupportedDocFormat(mimeType, fileName) && !fileName.endsWith('.pdf') && !mimeType.includes('pdf')) {
            await safeSend(chatId, '📄 I can process PDF, DOCX, CSV, and TXT files. Please send a supported format.\n\nFor photos of receipts, just send them as a photo! 📸');
            return;
        }

        // Handle grouped documents (batching) - process sequentially
        const groupId = msg.media_group_id;
        if (groupId) {
            if (!mediaGroups.has(groupId)) {
                mediaGroups.set(groupId, { items: [], timer: null, chatId, telegramId });
                await safeSend(chatId, '📥 Receiving multiple documents... This might take several seconds.');
            }
            
            const group = mediaGroups.get(groupId);
            if (group.items.length >= 10) return; // Drop extras to prevent abuse
            
            group.items.push(msg);
            clearTimeout(group.timer);
            
            group.timer = setTimeout(async () => {
                const grp = mediaGroups.get(groupId);
                if (!grp) return;
                mediaGroups.delete(groupId);
                
                await safeSend(chatId, `📄 Processing ${grp.items.length} document(s) sequentially...`);
                for (const item of grp.items) {
                    await processDocumentFile(item.document.file_id, item.document.mime_type || '', item.document.file_name || '', chatId, telegramId, user);
                }
            }, 3000);
            return;
        }

        // Single document
        await processDocumentFile(doc.file_id, mimeType, fileName, chatId, telegramId, user);

    } catch (err) {
        console.error('Document handling error:', err);
        await safeSend(chatId, '❌ Something went wrong receiving your document.');
    }
}

// ============ UNIFIED AI RESPONSE HANDLER ============
async function handleAIResponse(chatId, telegramId, user, result, source, usageWarning = '') {
    const action = result.action || 'log';

    // Handle clarification needed
    if (result.clarification_needed) {
        await safeSend(chatId, `❓ ${result.clarification_needed}`);
        // Still process any transactions that were found
    }

    if (action === 'log' && result.transactions && result.transactions.length > 0) {
        // Normal transaction logging
        const saved = await saveMultipleTransactions(user.id, result.transactions, source);
        const confirmMsg = formatConfirmation(result.transactions, result.summary) + usageWarning;
        await safeSend(chatId, confirmMsg, { parse_mode: 'Markdown' });

    } else if (action === 'edit') {
        // Handle edit request
        const target = result.edit_target;
        if (!target) {
            await safeSend(chatId, result.summary || '❓ I couldn\'t figure out which record to edit. Can you be more specific?');
            return;
        }

        // Find matching transactions
        const filters = {};
        if (target.date) filters.date = target.date;
        if (target.description) filters.description = target.description;
        if (target.category) filters.category = target.category;
        if (target.old_amount) filters.amount = target.old_amount;

        const matches = await findTransactionByContext(user.id, filters);

        if (matches.length === 0) {
            await safeSend(chatId, `❌ I couldn't find a matching transaction to edit. ${result.summary || ''}\n\n_Try being more specific about the date, amount, or description._`, { parse_mode: 'Markdown' });
            return;
        }

        const match = matches[0]; // Take the best match
        const updates = {};
        let changeDesc = '';

        if (target.new_amount !== null && target.new_amount !== undefined) {
            updates.amount = target.new_amount;
            changeDesc += `Amount: ${formatNaira(Number(match.amount))} → *${formatNaira(target.new_amount)}*\n`;
        }
        if (target.new_description) {
            updates.description = target.new_description;
            changeDesc += `Description: "${match.description}" → "${target.new_description}"\n`;
        }
        if (target.new_category) {
            updates.category = target.new_category;
            changeDesc += `Category: ${match.category} → ${target.new_category}\n`;
        }

        if (Object.keys(updates).length === 0) {
            await safeSend(chatId, result.summary || '❓ I couldn\'t determine what to change. Can you tell me the new value?');
            return;
        }

        // Ask for confirmation
        const typeEmoji = match.type === 'income' ? '💰' : '💸';
        const confirmMsg = `✏️ *Edit this record?*\n\n${typeEmoji} ${match.date} — ${match.description}: ${formatNaira(Number(match.amount))} (${match.category})\n\n*Changes:*\n${changeDesc}`;

        pendingActions.set(telegramId, {
            type: 'edit',
            transactionId: match.id,
            updates,
            summary: changeDesc,
        });

        await safeSend(chatId, confirmMsg, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Yes, update', callback_data: 'confirm_edit_yes' },
                        { text: '❌ Cancel', callback_data: 'confirm_edit_no' },
                    ]
                ]
            }
        });

    } else if (action === 'delete') {
        // Handle delete request
        const target = result.edit_target;
        if (!target) {
            await safeSend(chatId, result.summary || '❓ I couldn\'t figure out which record to delete. Can you be more specific?');
            return;
        }

        const filters = {};
        if (target.date) filters.date = target.date;
        if (target.description) filters.description = target.description;
        if (target.category) filters.category = target.category;
        if (target.old_amount) filters.amount = target.old_amount;

        const matches = await findTransactionByContext(user.id, filters);

        if (matches.length === 0) {
            await safeSend(chatId, `❌ I couldn't find a matching transaction to delete. ${result.summary || ''}\n\n_Try being more specific about the date, amount, or description._`, { parse_mode: 'Markdown' });
            return;
        }

        const match = matches[0];
        const typeEmoji = match.type === 'income' ? '💰' : '💸';
        const confirmMsg = `🗑️ *Delete this record?*\n\n${typeEmoji} ${match.date} — ${match.description}: ${formatNaira(Number(match.amount))} (${match.category})\n\n_This action cannot be undone._`;

        pendingActions.set(telegramId, {
            type: 'delete',
            transactionId: match.id,
            summary: `${typeEmoji} ${match.date} — ${match.description}: ${formatNaira(Number(match.amount))}`,
        });

        await safeSend(chatId, confirmMsg, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🗑️ Yes, delete', callback_data: 'confirm_delete_yes' },
                        { text: '↩️ Cancel', callback_data: 'confirm_delete_no' },
                    ]
                ]
            }
        });

    } else {
        // Chat/query response or no transactions found
        if (result.summary) {
            await safeSend(chatId, result.summary + usageWarning);
        }
    }
}

// ============ ONBOARDING FLOW ============
async function handleOnboarding(chatId, telegramId, text, user) {
    if (user.onboarding_step === 'ask_type') {
        // Map button text to business type
        const typeMap = {
            '🍲 Food / Restaurant': 'Food / Restaurant',
            '👗 Fashion / Tailoring': 'Fashion / Tailoring',
            '🏪 Retail / Shop': 'Retail / Shop',
            '✂️ Services': 'Services',
            '📦 Other': 'Other'
        };

        const businessType = typeMap[text] || text;
        await updateUser(telegramId, { business_type: businessType, onboarding_step: 'ask_name' });

        const emoji = text.includes('Food') ? '🍲' : text.includes('Fashion') ? '👗' : text.includes('Retail') ? '🏪' : text.includes('Services') ? '✂️' : '📦';

        await safeSend(chatId,
            `${emoji} Nice choice!\n\nWhat's your business name? (or just a nickname)`,
            { reply_markup: { remove_keyboard: true } }
        );
    } else if (user.onboarding_step === 'ask_name') {
        await updateUser(telegramId, { business_name: text, onboarding_step: 'ask_location' });

        await safeSend(chatId,
            `Got it, *${text}*! 👍\n\nLastly, what City or State are you operating from? (e.g., Lagos, Abuja, Port Harcourt)`,
            { parse_mode: 'Markdown' }
        );
    } else if (user.onboarding_step === 'ask_location') {
        await updateUser(telegramId, { location: text, onboarding_step: 'complete' });

        await safeSend(chatId,
            `🎉 You're all set!\n\nFrom now on, just send me:\n📸 Photo of your sales book or receipts\n🎤 Voice note about your day\n✍️ Or just type it out\n📄 PDF bank statements or receipts\n\nI'll track everything and give you a *health report every Sunday*.\n\n📊 Your plan: 🆓 Free (${FREE_DAILY_LIMIT} messages/day)\n🌟 Send /premium to unlock unlimited\n📤 Send /export for professional PDF & Excel reports\n\n💡 *Try it now* — tell me about today's sales!`,
            { parse_mode: 'Markdown' }
        );

        // Notify Admins
        try {
            const { sendAdminAlert } = require('./admin');
            const username = user.telegram_username ? '@' + user.telegram_username : 'No username';
            await sendAdminAlert(`🎉 *New User Registered!*\n\n• Business: ${user.business_name}\n• Type: ${user.business_type}\n• Location: ${text}\n• Username: ${username}`);
        } catch(e) {
            console.error('Failed to notify admins:', e);
        }
    }
}

// ============ CONFIRMATION MESSAGE ============
function formatConfirmation(transactions, summary) {
    let msg = `Got it! 📝\n\n`;

    const incomes = transactions.filter(t => t.type === 'income');
    const expenses = transactions.filter(t => t.type === 'expense');

    if (incomes.length > 0) {
        incomes.forEach(t => {
            const methodTag = t.payment_method && t.payment_method !== 'unknown' ? ` [${t.payment_method}]` : '';
            msg += `💰 ${t.description}: *${formatNaira(t.amount)}*${methodTag}\n`;
        });
    }

    if (expenses.length > 0) {
        expenses.forEach(t => {
            const catEmoji = t.category === 'Supplies' || t.category === 'Raw Materials' || t.category === 'Stock Purchase' ? '📦' :
                            t.category === 'Transport' || t.category === 'Loading/Haulage' ? '🚚' :
                            t.category === 'Staff/Wages' ? '👷' :
                            t.category === 'Utilities' || t.category === 'Generator/Fuel' || t.category === 'Electricity' ? '⚡' :
                            t.category === 'Marketing/Advertising' ? '📢' :
                            t.category === 'Delivery Fees' ? '🏍️' :
                            t.category === 'Rent' ? '🏠' :
                            t.category === 'Communication/Data' ? '📱' :
                            t.category === 'Equipment' ? '🔧' :
                            t.category === 'Bank Charges' || t.category === 'Interest' ? '🏦' : '💸';
            const methodTag = t.payment_method && t.payment_method !== 'unknown' ? ` [${t.payment_method}]` : '';
            msg += `${catEmoji} ${t.description}: *${formatNaira(t.amount)}*${methodTag}\n`;
        });
    }

    const totalIncome = incomes.reduce((sum, t) => sum + t.amount, 0);
    const totalExpense = expenses.reduce((sum, t) => sum + t.amount, 0);
    const profit = totalIncome - totalExpense;

    msg += `\n`;

    if (totalIncome > 0 && totalExpense > 0) {
        const emoji = profit >= 0 ? '✅' : '⚠️';
        msg += `📊 Today's Profit: *${formatNaira(profit)}* ${emoji}\n`;
    }

    msg += `\n_Anything I got wrong? Just reply to correct me, or say "change X to Y"._`;

    return msg;
}

// ============ FORMAT HISTORY ============
function formatTransactionContext(transactions) {
    if (!transactions || transactions.length === 0) return 'No recent transactions recorded yet.';
    
    return transactions.map(t => {
        const amountStr = `₦${Number(t.amount).toLocaleString()}`;
        const method = t.payment_method && t.payment_method !== 'unknown' ? ` [${t.payment_method}]` : '';
        return `[ID:${t.id}] [Date: ${t.date}] ${t.type.toUpperCase()} - ${t.category}: ${amountStr} ("${t.description}")${method}`;
    }).join('\n');
}

// ============ WEEKLY REPORT SCHEDULER ============
function scheduleWeeklyReports() {
    const cron = require('node-cron');
    
    // '0 18 * * 0' -> 6:00 PM (18:00) on Sunday (0)
    cron.schedule('0 18 * * 0', async () => {
        console.log('📋 Generating weekly reports (CRON)...');
        await sendWeeklyReports();
    }, {
        scheduled: true,
        timezone: "Africa/Lagos"
    });
}

async function sendWeeklyReports() {
    try {
        const users = await getAllUsers();

        for (const user of users) {
            try {
                // Skip users who turned off notifications
                if (Number(user.notifications_enabled) === 0) continue;

                const { weekStart, weekEnd } = getWeekRange();
                const summary = await getWeeklySummary(user.id, weekStart, weekEnd);

                if (summary.transaction_count === 0) continue;

                const prevRange = getPreviousWeekRange();
                const prevSummary = await getWeeklySummary(user.id, prevRange.weekStart, prevRange.weekEnd);
                const prevReport = prevSummary.transaction_count > 0 ? prevSummary : null;

                const report = await generateHealthReport(summary, user.business_name, user.business_type, prevReport);
                await saveHealthReport(user.id, weekStart, weekEnd, { ...report, ...summary });

                await safeSend(user.telegram_id, report.telegram_message, { parse_mode: 'Markdown' });

                // Rate limit: wait 1s between users
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (err) {
                console.error(`Failed to send report for user ${user.id}:`, err.message);
            }
        }
    } catch (err) {
        console.error('Weekly reports error:', err);
    }
}

// ============ DOWNLOAD FILE HELPER ============
function downloadFile(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;

        protocol.get(url, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function getBot() {
    return bot;
}

module.exports = { initBot, getBot };
