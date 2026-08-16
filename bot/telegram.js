const TelegramBot = require('node-telegram-bot-api');
const https = require('https');
const http = require('http');
const { findUserByTelegramId, createUser, updateUser, saveMultipleTransactions, getWeeklySummary, saveHealthReport, getLatestReport, getAllUsers, checkAndIncrementUsage, FREE_DAILY_LIMIT, getTransactions, getLifetimeSummary, deleteLastTransaction } = require('../db/schema');
const { processTextInput, processImage, processVoiceNote, generateHealthReport } = require('../ai/processor');
const { formatNaira, getWeekRange, getPreviousWeekRange } = require('../utils/helpers');

let bot = null;

function initBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');

    bot = new TelegramBot(token, { polling: true });

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

    console.log('🤖 Telegram bot is listening...');
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
                `Welcome back! 👋\n\nI remember you — *${user.business_name}*\nPlan: ${plan}\n\nJust send me your daily sales and expenses as usual. Voice notes, photos, or text — I've got you!\n\n📊 /report — Get your health report\n📋 /status — Check your usage\n🌟 /premium — Upgrade your plan`,
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
    await safeSend(msg.chat.id,
        `🩺 *Kobowise Help*\n\nHere's what I can do:\n\n📱 *Send data:*\n• 🎤 Voice note — speak naturally in English or Pidgin\n• 📸 Photo — snap your sales book or receipts\n• ✍️ Text — just type your sales and expenses\n\n📊 *Commands:*\n• /report — Get your latest health report\n• /balance — View today's and all-time financials\n• /status — Check your usage and plan\n• /export — Download your data as a CSV file\n• /settings — Change language, notifications, and name\n• /cancel — Undo your last entry or reset state\n• /premium — View upgrade options\n• /help — Show this help message\n• /start — Restart onboarding\n\nI automatically send your weekly health report every Sunday at 6 PM! 📋\n\n🆓 *Free plan:* ${FREE_DAILY_LIMIT} messages/day + weekly reports\n🌟 *Premium:* Unlimited messages + daily reports + advanced insights`,
        { parse_mode: 'Markdown' }
    );
}

// ============ /PREMIUM ============
async function handlePremium(msg) {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);

    try {
        const user = await findUserByTelegramId(telegramId);
        const isPremium = user && Number(user.is_premium) === 1;

        if (isPremium) {
            const expires = user.premium_expires_at ? new Date(user.premium_expires_at).toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' }) : 'Never';
            await safeSend(chatId,
                `🌟 *You're on Premium!*\n\nExpires: ${expires}\n\n✅ Unlimited messages/day\n✅ Daily + weekly health reports\n✅ Advanced AI insights & prescriptions\n✅ Full transaction history\n✅ Priority support\n\nThank you for supporting Kobowise! 💛`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        await safeSend(chatId,
            `🌟 *KOBOWISE PREMIUM*\n\n━━━━━━━━━━━━━━━━━━\n\n🆓 *Free Plan* (Current)\n• ${FREE_DAILY_LIMIT} messages per day\n• Weekly health reports (Sundays)\n• Basic expense categorization\n\n━━━━━━━━━━━━━━━━━━\n\n🌟 *Premium Plan* — ₦1,500/month\n• ✅ *Unlimited* messages per day\n• ✅ Daily mini-reports + weekly deep reports\n• ✅ Advanced AI insights & prescriptions\n• ✅ Expense trend analysis\n• ✅ Best/worst day identification\n• ✅ Full transaction history\n• ✅ Custom expense categories\n• ✅ Priority support\n\n━━━━━━━━━━━━━━━━━━\n\n💰 *How to Upgrade*\nPlease transfer exactly *₦1,500* to the official account below:\n\nBank: *Opay*\nAcc Name: *Egemonye Marvellous Kenechukwu*\nAcc No: \`9068539301\`\n\n⚠️ *ANTI-SCAM DISCLAIMER*\nKobowise will NEVER ask you to pay into any other account. The account details listed above are the ONLY verified and official payment channels for Kobowise Premium. Do not send money to any other account.\n\n_Once you have made the transfer, click the button below to submit your receipt!_`,
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
        if (!user || user.onboarding_step !== 'complete') {
            await safeSend(chatId, 'Please complete setup first! Send /start');
            return;
        }

        const isPremium = Number(user.is_premium) === 1;
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

// ============ /EXPORT ============
async function handleExport(msg) {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);

    try {
        const user = await findUserByTelegramId(telegramId);
        if (!user || user.onboarding_step !== 'complete') {
            await safeSend(chatId, 'Please complete setup first! Send /start');
            return;
        }

        await safeSend(chatId, '📤 Generating your export file...');

        const transactions = await getTransactions(user.id);

        if (!transactions || transactions.length === 0) {
            await safeSend(chatId, '📋 No transactions to export yet!\n\nStart sending me your sales and expenses and I\'ll have data ready for you to download.');
            return;
        }

        // Build PDF content
        const PDFDocument = require('pdfkit-table');
        const doc = new PDFDocument({ margin: 30, size: 'A4' });
        
        const buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        
        const totalIncome = transactions.filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amount), 0);
        const totalExpense = transactions.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0);
        
        doc.on('end', async () => {
            const pdfData = Buffer.concat(buffers);
            const fileName = `Kobowise_${user.business_name.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.pdf`;

            await bot.sendDocument(chatId, pdfData, {
                caption: `📊 *${user.business_name}* — Full Export\n\n📝 ${transactions.length} transactions\n💰 Revenue: ${formatNaira(totalIncome)}\n💸 Expenses: ${formatNaira(totalExpense)}\n📈 Profit: ${formatNaira(totalIncome - totalExpense)}`,
                parse_mode: 'Markdown'
            }, {
                filename: fileName,
                contentType: 'application/pdf'
            });
        });

        doc.fontSize(20).text(`${user.business_name} - Transaction Report`, { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(`Generated on: ${new Date().toISOString().split('T')[0]}`, { align: 'center' });
        doc.moveDown();

        const tableArray = {
            headers: ["Date", "Type", "Category", "Amount", "Description"],
            rows: transactions.map(t => [
                t.date,
                t.type.toUpperCase(),
                t.category,
                Number(t.amount).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' }),
                t.description || ''
            ])
        };

        tableArray.rows.push(["", "", "", "", ""]); // empty divider
        tableArray.rows.push(["TOTALS", "", "", "", ""]);
        tableArray.rows.push(["", "Revenue", "", Number(totalIncome).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' }), ""]);
        tableArray.rows.push(["", "Expenses", "", Number(totalExpense).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' }), ""]);
        tableArray.rows.push(["", "Net Profit", "", Number(totalIncome - totalExpense).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' }), ""]);

        await doc.table(tableArray, { width: 535 });
        doc.end();
    } catch (err) {
        console.error('Export error:', err);
        await safeSend(chatId, '❌ Could not generate your export. Please try again.');
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

// ============ CALLBACK QUERY HANDLER (for /settings buttons) ============
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

        if (data === 'settings_lang_en') {
            await updateUser(telegramId, { language: 'en' });
            await bot.answerCallbackQuery(query.id, { text: '🇬🇧 Language set to English!' });
            // Refresh the settings message
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

        if (result.transactions.length > 0) {
            const saved = await saveMultipleTransactions(user.id, result.transactions, 'text');
            const confirmMsg = formatConfirmation(result.transactions, result.summary) + usageWarning;
            await safeSend(chatId, confirmMsg, { parse_mode: 'Markdown' });
        } else {
            await safeSend(chatId, result.summary);
        }
    } catch (err) {
        console.error('Text processing error:', err);
        if (err.message.includes('GEMINI_API_KEY')) {
            await safeSend(chatId, '⚠️ AI is not configured yet. The admin needs to set up the GEMINI_API_KEY.');
        } else {
            await safeSend(chatId, '❌ Sorry, something went wrong with the database or AI. Please try again.');
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

        if (result.transactions.length > 0) {
            await saveMultipleTransactions(user.id, result.transactions, 'voice');
            const confirmMsg = formatConfirmation(result.transactions, result.summary) + usageWarning;
            await safeSend(chatId, confirmMsg, { parse_mode: 'Markdown' });
        } else {
            await safeSend(chatId, result.summary);
        }
    } catch (err) {
        console.error('Voice processing error:', err);
        await safeSend(chatId, '❌ Couldn\'t process your voice note (connection might be slow). Try speaking a bit clearer, or type it out instead.');
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
            
            // Revert state to complete so they can continue using the bot
            await updateUser(telegramId, { onboarding_step: 'complete' });

            try {
                const { forwardPremiumReceipt } = require('./admin');
                const photo = msg.photo[msg.photo.length - 1]; 
                await forwardPremiumReceipt(user.id, user.business_name, user.telegram_username, user.telegram_id, photo.file_id);
            } catch (e) {
                console.error("Failed to forward receipt to admin:", e);
            }
            return;
        }

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

        await safeSend(chatId, '📸 Reading your photo...');
        await bot.sendChatAction(chatId, 'typing').catch(() => {});

        // Get highest resolution photo
        const photo = msg.photo[msg.photo.length - 1];
        const file = await bot.getFile(photo.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const imageBuffer = await downloadFile(fileUrl);

        // Determine mime type
        const mimeType = file.file_path.endsWith('.png') ? 'image/png' : 'image/jpeg';

        // Fetch recent context for Q&A
        const recentTxs = await getTransactions(user.id, { limit: 50 });
        const contextStr = formatTransactionContext(recentTxs);

        // Process with Gemini Vision
        const result = await processImage(imageBuffer, mimeType, user.business_type, contextStr);

        if (result.transactions.length > 0) {
            await saveMultipleTransactions(user.id, result.transactions, 'photo');
            const confirmMsg = formatConfirmation(result.transactions, result.summary) + usageWarning;
            await safeSend(chatId, confirmMsg, { parse_mode: 'Markdown' });
        } else {
            await safeSend(chatId, result.summary);
        }
    } catch (err) {
        console.error('Photo processing error:', err);
        await safeSend(chatId, '❌ Couldn\'t read your photo (connection might be slow). Try taking a clearer picture with better lighting.');
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
            `🎉 You're all set!\n\nFrom now on, just send me:\n📸 Photo of your sales book or receipts\n🎤 Voice note about your day\n✍️ Or just type it out\n\nI'll track everything and give you a *health report every Sunday*.\n\n📊 Your plan: 🆓 Free (${FREE_DAILY_LIMIT} messages/day)\n🌟 Send /premium to unlock unlimited\n\n💡 *Try it now* — tell me about today's sales!`,
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
            msg += `💰 ${t.description}: *${formatNaira(t.amount)}*\n`;
        });
    }

    if (expenses.length > 0) {
        expenses.forEach(t => {
            const catEmoji = t.category === 'Supplies' || t.category === 'Raw Materials' ? '📦' :
                            t.category === 'Transport' ? '🚚' :
                            t.category === 'Staff' ? '👷' :
                            t.category === 'Utilities' ? '⚡' : '💸';
            msg += `${catEmoji} ${t.description}: *${formatNaira(t.amount)}*\n`;
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

    msg += `\n_Anything I got wrong? Just reply to correct me._`;

    return msg;
}

// ============ FORMAT HISTORY ============
function formatTransactionContext(transactions) {
    if (!transactions || transactions.length === 0) return 'No recent transactions recorded yet.';
    
    return transactions.map(t => {
        const amountStr = `₦${Number(t.amount).toLocaleString()}`;
        return `[Date: ${t.date}] ${t.type.toUpperCase()} - ${t.category}: ${amountStr} ("${t.description}")`;
    }).join('\n');
}

// ============ WEEKLY REPORT SCHEDULER ============
function scheduleWeeklyReports() {
    // Check every hour if it's Sunday 6 PM WAT (5 PM UTC)
    setInterval(async () => {
        const now = new Date();
        const utcHour = now.getUTCHours();
        const utcDay = now.getUTCDay(); // 0 = Sunday

        // Sunday at 5 PM UTC (6 PM WAT)
        if (utcDay === 0 && utcHour === 17) {
            console.log('📋 Generating weekly reports...');
            await sendWeeklyReports();
        }
    }, 60 * 60 * 1000); // Check every hour
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
