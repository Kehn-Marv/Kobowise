const TelegramBot = require('node-telegram-bot-api');
const { getAllUsers, getAdminStats, isAdmin, addAdmin, removeAdmin, getAllAdmins, getAdminSettings, updateAdminSettings, getAdminsForRealtimeNotifs, createBroadcast, logBroadcastMessage, getBroadcastLogs, getRecentBroadcasts, markBroadcastDeleted } = require('../db/schema');

let globalAdminBot = null;

function startAdminBot(app, webhookUrl) {
    const token = process.env.ADMIN_BOT_TOKEN;
    if (!token) {
        console.log('⚠️ ADMIN_BOT_TOKEN not provided. Admin bot is disabled.');
        return null;
    }

    let adminBot;

    if (webhookUrl) {
        adminBot = new TelegramBot(token);
        globalAdminBot = adminBot;
        const url = `${webhookUrl}/api/bot/admin`;
        adminBot.setWebHook(url).catch(err => console.error('Admin Bot Webhook Error:', err.message));
        if (app) {
            app.post('/api/bot/admin', (req, res) => {
                adminBot.processUpdate(req.body);
                res.sendStatus(200);
            });
        }
        console.log(`🛡️ Admin bot initialized with Webhook: ${url}`);
    } else {
        adminBot = new TelegramBot(token, { polling: true });
        globalAdminBot = adminBot;
        console.log('🛡️ Admin bot started on polling mode');
    }

    const adminStates = {};

    // --- Auth Middleware Helper ---
    async function checkAuth(msg) {
        const authorized = await isAdmin(msg.from.id);
        if (!authorized) {
            // Silent security — ignore unauthorized users completely
            console.log(`[Admin Bot] Unauthorized access attempt from ${msg.from.id} (@${msg.from.username})`);
            return false;
        }
        return true;
    }

    adminBot.onText(/^\/start$/, async (msg) => {
        if (!(await checkAuth(msg))) return;
        await adminBot.sendMessage(msg.chat.id, 
            `🛡️ *Kobowise Admin Panel*\n\nWelcome back, Admin.\n\nTo see everything you can do, send /help to view the full command menu.`,
            { parse_mode: 'Markdown' }
        );
    });

    adminBot.onText(/^\/help$/, async (msg) => {
        if (!(await checkAuth(msg))) return;
        const helpText = `🛠️ *Kobowise Admin Bot — Help Menu*

*Analytics & Users:*
• /stats — View your user growth, platform activity, regions, languages, and logging input methods.
• /users — Generates a numbered list of all registered users on the bot along with their profile data.

*Broadcasting & Messaging:*
• /broadcast — Starts a "Collection Session". You can send multiple photos, videos, voice notes, and texts to the bot. Click "Finish" and it clones them directly to every single user exactly as you sent them.
• /broadcasts — Shows your 10 most recent broadcast sessions, their IDs, and whether they have been recalled.
• /deletebroadcast — Triggers a conversational prompt to recall/undo a sent broadcast for everyone (or a specific user).

*God-Mode Actions:*
• /msg <telegram_id> <message> — Send a direct DM to a user from the main bot.
• /giftpremium <telegram_id> — Instantly upgrade a user to Premium.
• /revokepremium <telegram_id> — Remove a user's Premium status.
• /block <telegram_id> — Ban a user from using the bot.
• /unblock <telegram_id> — Unban a user.
• /backup — Download a complete JSON backup of the users & transactions database.

*Admin & Security Management:*
• /admins — Shows all currently authorized admins. The Master Admin (you) is listed at the top.
• /addadmin — Prompts you to paste a user's Telegram ID to instantly grant them full access to this bot.
• /removeadmin — Prompts you to revoke a user's access.
• /settings — Opens an interactive settings dashboard. Let's you configure if you want to be alerted when a new user registers, and how often.

_Tip: Unauthorized users will not see any replies from this bot (Silent Security)._`;

        await adminBot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
    });

    // --- Admin Management Commands ---

    adminBot.onText(/^\/stats$/, async (msg) => {
        if (!(await checkAuth(msg))) return;
        const chatId = msg.chat.id;
        try {
            const stats = await getAdminStats();
            let text = `📊 *Kobowise Platform Stats*\n\n`;
            text += `👥 Total Users: ${stats.users.total}\n`;
            text += `⭐ Premium Users: ${stats.users.premium}\n\n`;
            text += `📈 Total Transactions: ${stats.transactions.total}\n`;
            text += `🔥 Today's Transactions: ${stats.transactions.today}\n`;
            if (stats.transactions.peak_hour_utc) {
                text += `⏰ Peak Hour (UTC): ${stats.transactions.peak_hour_utc}:00\n`;
            }
            text += `\n🌐 *Top Regions:*\n`;
            for (const r of stats.users.top_locations) text += `• ${r.location || 'Unknown'}: ${r.count}\n`;
            text += `\n🗣️ *Languages:*\n`;
            for (const l of stats.users.languages) text += `• ${l.lang || 'Unknown'}: ${l.count}\n`;
            text += `\n📥 *Input Sources:*\n`;
            for (const s of stats.transactions.sources) text += `• ${s.source || 'text'}: ${s.count}\n`;

            await adminBot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        } catch (e) {
            console.error(e);
            await adminBot.sendMessage(chatId, '❌ Failed to load stats.');
        }
    });

    adminBot.onText(/^\/users$/, async (msg) => {
        if (!(await checkAuth(msg))) return;
        const chatId = msg.chat.id;
        try {
            const users = await getAllUsers();
            if (users.length === 0) {
                return adminBot.sendMessage(chatId, 'No users registered yet.');
            }
            let text = `👥 *Registered Users (${users.length})*\n\n`;
            users.forEach((u, i) => {
                const type = u.business_type || 'Unknown';
                const loc = u.location || 'Unknown';
                // Avoid Markdown breaking on usernames with underscores by using code blocks
                text += `${i+1}. ${u.business_name} (${type})\n   📍 ${loc} | \`${u.telegram_username ? '@'+u.telegram_username : 'No username'}\`\n`;
            });
            await adminBot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        } catch (e) {
            console.error(e);
            await adminBot.sendMessage(chatId, '❌ Failed to load users.');
        }
    });

    adminBot.onText(/\/admins/, async (msg) => {
        if (!(await checkAuth(msg))) return;
        const chatId = msg.chat.id;

        try {
            const admins = await getAllAdmins();
            let text = `👮 *Authorized Admins*\n\n`;
            
            // Master admin
            text += `👑 Master Admin: \`${process.env.MASTER_ADMIN_ID || 'Not Set'}\`\n\n`;

            if (admins.length > 0) {
                admins.forEach((a, i) => {
                    text += `${i+1}. \`${a.telegram_id}\`\n   Added by: ${a.added_by}\n`;
                });
            } else {
                text += `_No additional admins._`;
            }

            await adminBot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        } catch (err) {
            console.error(err);
        }
    });

    adminBot.onText(/^\/addadmin$/, async (msg) => {
        if (!(await checkAuth(msg))) return;
        const prompt = await adminBot.sendMessage(msg.chat.id, 'Please enter the Telegram ID of the user you want to add as an admin:\n\nType /cancel to abort.', { parse_mode: 'Markdown' });
        adminStates[msg.from.id] = { action: 'addadmin', promptMsgId: prompt.message_id };
    });

    adminBot.onText(/^\/removeadmin$/, async (msg) => {
        if (!(await checkAuth(msg))) return;
        const prompt = await adminBot.sendMessage(msg.chat.id, 'Please enter the Telegram ID of the admin you want to remove:\n\nType /cancel to abort.', { parse_mode: 'Markdown' });
        adminStates[msg.from.id] = { action: 'removeadmin', promptMsgId: prompt.message_id };
    });

    adminBot.onText(/^\/backup$/, async (msg) => {
        if (!(await checkAuth(msg))) return;
        const chatId = msg.chat.id;
        try {
            await adminBot.sendMessage(chatId, '📦 Generating database backup...');
            const { getAllUsers } = require('../db/schema');
            const { getDB } = require('../db/schema');
            const client = getDB();
            
            // Get all data
            const users = await getAllUsers();
            const txsRes = await client.execute('SELECT * FROM transactions');
            
            const backupData = {
                timestamp: new Date().toISOString(),
                users: users,
                transactions: txsRes.rows
            };
            
            const fs = require('fs');
            const backupPath = './backup.json';
            fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));
            
            await adminBot.sendDocument(chatId, backupPath, { caption: '✅ Database Backup' });
            
            // Clean up
            fs.unlinkSync(backupPath);
        } catch (e) {
            console.error('Backup error:', e);
            await adminBot.sendMessage(chatId, `❌ Failed to generate backup: ${e.message}`);
        }
    });

    adminBot.onText(/^\/giftpremium (\d+)$/, async (msg, match) => {
        if (!(await checkAuth(msg))) return;
        const targetId = match[1];
        try {
            const { getDB } = require('../db/schema');
            const client = getDB();
            await client.execute({ sql: 'UPDATE users SET is_premium = 1 WHERE telegram_id = ?', args: [targetId] });
            await adminBot.sendMessage(msg.chat.id, `✅ User ${targetId} is now Premium.`);
            
            const { getBot } = require('./telegram');
            const mainBot = getBot();
            if (mainBot) {
                await mainBot.sendMessage(targetId, '🎉 *Premium Activated!*\n\nAn admin has manually gifted you Premium. You now have unlimited access to Kobowise Premium!', { parse_mode: 'Markdown' }).catch(()=>{});
            }
        } catch (e) {
            await adminBot.sendMessage(msg.chat.id, `❌ Failed: ${e.message}`);
        }
    });

    adminBot.onText(/^\/revokepremium (\d+)$/, async (msg, match) => {
        if (!(await checkAuth(msg))) return;
        const targetId = match[1];
        try {
            const { getDB } = require('../db/schema');
            const client = getDB();
            await client.execute({ sql: 'UPDATE users SET is_premium = 0 WHERE telegram_id = ?', args: [targetId] });
            await adminBot.sendMessage(msg.chat.id, `✅ User ${targetId} is no longer Premium.`);
        } catch (e) {
            await adminBot.sendMessage(msg.chat.id, `❌ Failed: ${e.message}`);
        }
    });

    adminBot.onText(/^\/block (\d+)$/, async (msg, match) => {
        if (!(await checkAuth(msg))) return;
        const targetId = match[1];
        try {
            const { blockUser } = require('../db/schema');
            await blockUser(targetId);
            await adminBot.sendMessage(msg.chat.id, `🚫 User ${targetId} has been blocked.`);
        } catch (e) {
            await adminBot.sendMessage(msg.chat.id, `❌ Failed: ${e.message}`);
        }
    });

    adminBot.onText(/^\/unblock (\d+)$/, async (msg, match) => {
        if (!(await checkAuth(msg))) return;
        const targetId = match[1];
        try {
            const { unblockUser } = require('../db/schema');
            await unblockUser(targetId);
            await adminBot.sendMessage(msg.chat.id, `✅ User ${targetId} has been unblocked.`);
        } catch (e) {
            await adminBot.sendMessage(msg.chat.id, `❌ Failed: ${e.message}`);
        }
    });

    adminBot.onText(/^\/msg (\d+) (.+)$/, async (msg, match) => {
        if (!(await checkAuth(msg))) return;
        const targetId = match[1];
        const textMsg = match[2];
        try {
            const { getBot } = require('./telegram');
            const mainBot = getBot();
            if (mainBot) {
                await mainBot.sendMessage(targetId, `💬 *Message from Support:*\n\n${textMsg}`, { parse_mode: 'Markdown' }).catch(()=>{});
                await adminBot.sendMessage(msg.chat.id, `✅ Message sent to ${targetId}.`);
            } else {
                await adminBot.sendMessage(msg.chat.id, `❌ Main bot is not running.`);
            }
        } catch (e) {
            await adminBot.sendMessage(msg.chat.id, `❌ Failed to send message: ${e.message}`);
        }
    });

    adminBot.onText(/^\/broadcast$/, async (msg) => {
        if (!(await checkAuth(msg))) return;
        
        const keyboard = {
            inline_keyboard: [
                [{ text: '📢 Send to Everyone', callback_data: 'broadcast_finish_all' }],
                [{ text: '🆓 Send to Free Users', callback_data: 'broadcast_finish_free' }],
                [{ text: '🌟 Send to Premium Users', callback_data: 'broadcast_finish_premium' }],
                [{ text: '❌ Cancel', callback_data: 'broadcast_cancel' }]
            ]
        };

        const prompt = await adminBot.sendMessage(msg.chat.id, 'Please send all the messages, photos, voice notes, etc. you want to broadcast.\n\nWhen you are done sending everything, choose your target audience below.', { parse_mode: 'Markdown', reply_markup: keyboard });
        adminStates[msg.from.id] = { action: 'broadcast', promptMsgId: prompt.message_id, messages: [] };
    });

    adminBot.onText(/^\/cancel$/, async (msg) => {
        if (!(await checkAuth(msg))) return;
        if (adminStates[msg.from.id]) {
            try { await adminBot.deleteMessage(msg.chat.id, adminStates[msg.from.id].promptMsgId); } catch(e){}
            delete adminStates[msg.from.id];
            await adminBot.sendMessage(msg.chat.id, '❌ Action cancelled.');
        }
    });

    // Handle any message to process stateful inputs
    adminBot.on('message', async (msg) => {
        if (!(await checkAuth(msg))) return;
        
        // Skip commands
        if (msg.text && msg.text.startsWith('/')) return;

        const state = adminStates[msg.from.id];
        if (!state) return; // ignore if no active state

        const chatId = msg.chat.id;

        if (state.action === 'addadmin') {
            // Clean up prompt
            try { await adminBot.deleteMessage(chatId, state.promptMsgId); } catch(e){}
            delete adminStates[msg.from.id];
            
            const targetId = msg.text ? msg.text.trim() : '';
            if (!targetId) return adminBot.sendMessage(chatId, `❌ Invalid ID.`);
            try {
                await addAdmin(targetId, msg.from.id);
                await adminBot.sendMessage(chatId, `✅ Successfully granted admin access to \`${targetId}\`.`, { parse_mode: 'Markdown' });
            } catch (err) {
                await adminBot.sendMessage(chatId, `❌ Failed to add admin. They might already be an admin.`);
            }
        } else if (state.action === 'removeadmin') {
            // Clean up prompt
            try { await adminBot.deleteMessage(chatId, state.promptMsgId); } catch(e){}
            delete adminStates[msg.from.id];

            const targetId = msg.text ? msg.text.trim() : '';
            if (!targetId) return adminBot.sendMessage(chatId, `❌ Invalid ID.`);
            if (targetId === process.env.MASTER_ADMIN_ID) {
                return adminBot.sendMessage(chatId, `❌ Cannot remove the Master Admin.`);
            }
            try {
                await removeAdmin(targetId);
                await adminBot.sendMessage(chatId, `✅ Successfully revoked admin access for \`${targetId}\`.`, { parse_mode: 'Markdown' });
            } catch (err) {
                await adminBot.sendMessage(chatId, `❌ Failed to remove admin.`);
            }
        } else if (state.action === 'deletebroadcast') {
            // Clean up prompt
            try { await adminBot.deleteMessage(chatId, state.promptMsgId); } catch(e){}
            delete adminStates[msg.from.id];

            const args = msg.text ? msg.text.trim().split(/\s+/) : [];
            const broadcastId = parseInt(args[0]);
            const targetTelegramId = args[1] || null;

            if (isNaN(broadcastId)) {
                return adminBot.sendMessage(chatId, `❌ Invalid Broadcast ID. Please use numbers.`);
            }

            await executeBroadcastDeletion(chatId, broadcastId, targetTelegramId);
        } else if (state.action === 'broadcast') {
            // Push message to the queue instead of broadcasting immediately
            state.messages.push(msg);
        }
    });

    // --- Admin Settings & Callbacks ---
    async function sendSettingsMenu(chatId, telegramId, messageId = null) {
        const pref = await getAdminSettings(telegramId);
        
        // 0=Off, 1=Realtime, 2=Daily
        const isOff = pref === 0;
        const isRealtime = pref === 1;
        const isDaily = pref === 2;

        const text = `⚙️ *Admin Notification Settings*\n\nReceive alerts when new users register.`;
        
        const keyboard = {
            inline_keyboard: [
                [
                    { text: isOff ? '✅ Alerts: OFF' : 'Alerts: OFF', callback_data: 'set_notif_0' },
                    { text: !isOff ? '✅ Alerts: ON' : 'Alerts: ON', callback_data: 'set_notif_1' }
                ]
            ]
        };

        if (!isOff) {
            keyboard.inline_keyboard.push([
                { text: isRealtime ? '✅ Real-time' : 'Real-time', callback_data: 'set_notif_1' },
                { text: isDaily ? '✅ Daily Summary' : 'Daily Summary', callback_data: 'set_notif_2' }
            ]);
        }

        if (messageId) {
            await adminBot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        } else {
            await adminBot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        }
    }

    adminBot.onText(/^\/settings$/, async (msg) => {
        if (!(await checkAuth(msg))) return;
        await sendSettingsMenu(msg.chat.id, msg.from.id);
    });

    adminBot.onText(/^\/broadcasts$/, async (msg) => {
        if (!(await checkAuth(msg))) return;
        const chatId = msg.chat.id;
        try {
            const broadcasts = await getRecentBroadcasts(10);
            if (broadcasts.length === 0) {
                return adminBot.sendMessage(chatId, 'No recent broadcasts found.');
            }

            let text = `📢 *Recent Broadcasts*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
            broadcasts.forEach(b => {
                const deletedStatus = b.is_deleted ? ' `[🗑️ DELETED]`' : '';
                text += `🆔 *ID:* \`${b.id}\`${deletedStatus}\n📅 *Date:* ${b.created_at}\n👤 *Admin:* ${b.admin_id}\n📝 *Summary:* ${b.summary}\n\n`;
            });
            text += `_To delete a broadcast, use:_ \n\`/deletebroadcast\``;

            await adminBot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        } catch (e) {
            console.error('Error fetching broadcasts:', e);
            await adminBot.sendMessage(chatId, '❌ Failed to fetch broadcasts.');
        }
    });

    adminBot.onText(/^\/deletebroadcast$/, async (msg) => {
        if (!(await checkAuth(msg))) return;
        const prompt = await adminBot.sendMessage(msg.chat.id, 'Please enter the **Broadcast ID** you want to delete.\n\n_(Optional: If you only want to delete it for a specific user, put their Telegram ID after the Broadcast ID. e.g. `5 12345678`)_\n\nType /cancel to abort.', { parse_mode: 'Markdown' });
        adminStates[msg.from.id] = { action: 'deletebroadcast', promptMsgId: prompt.message_id };
    });

    async function executeBroadcastDeletion(chatId, broadcastId, targetTelegramId) {
        try {
            const logs = await getBroadcastLogs(broadcastId, targetTelegramId);
            if (logs.length === 0) {
                return adminBot.sendMessage(chatId, `❌ No messages found for broadcast ID ${broadcastId}${targetTelegramId ? ' for that user' : ''}.`);
            }

            const { getBot } = require('./telegram');
            const mainBot = getBot();
            if (!mainBot) return adminBot.sendMessage(chatId, '❌ Main bot is not running.');

            const statusMsg = await adminBot.sendMessage(chatId, `🗑️ Deleting ${logs.length} messages...\nPlease wait, this might take a minute to respect API limits.`);

            let success = 0;
            let fail = 0;

            for (const log of logs) {
                try {
                    await mainBot.deleteMessage(log.telegram_id, log.message_id);
                    success++;
                } catch (e) {
                    fail++;
                }
                await new Promise(r => setTimeout(r, 60)); // ~15/sec to avoid limits
            }

            // If deleted for everyone, mark it deleted in the database
            if (!targetTelegramId && success > 0) {
                try { await markBroadcastDeleted(broadcastId); } catch(e){}
            }

            await adminBot.sendMessage(chatId, `✅ **Deletion Complete for Broadcast #${broadcastId}**\n• Deleted: ${success}\n• Failed (too old or already deleted): ${fail}`, { parse_mode: 'Markdown' });
        } catch (e) {
            console.error('Delete broadcast error:', e);
            await adminBot.sendMessage(chatId, '❌ Failed to delete broadcast.');
        }
    }

    adminBot.on('callback_query', async (query) => {
        const msg = query.message;
        if (!(await checkAuth({ from: { id: query.from.id, username: query.from.username } }))) return;

        const data = query.data;

        if (data.startsWith('set_notif_')) {
            const newPref = parseInt(data.split('_')[2]);
            await updateAdminSettings(query.from.id, newPref);
            await sendSettingsMenu(msg.chat.id, query.from.id, msg.message_id);
            await adminBot.answerCallbackQuery(query.id, { text: 'Settings updated!' });
        } else if (data.startsWith('approve_premium_')) {
            const userId = parseInt(data.split('_')[2]);
            const { getDB } = require('../db/schema');
            const client = getDB();
            await client.execute({ sql: 'UPDATE users SET is_premium = 1 WHERE id = ?', args: [userId] });
            
            // Send success message to user
            const { getBot } = require('./telegram');
            const mainBot = getBot();
            if (mainBot) {
                const userRes = await client.execute({ sql: 'SELECT telegram_id FROM users WHERE id = ?', args: [userId] });
                if (userRes.rows[0]) {
                    await mainBot.sendMessage(userRes.rows[0].telegram_id, '🎉 *Premium Activated!*\n\nYour payment has been confirmed. You now have unlimited access to Kobowise Premium!', { parse_mode: 'Markdown' }).catch(()=>{});
                }
            }
            
            await adminBot.editMessageCaption(msg.caption + '\n\n✅ *Status: APPROVED*', { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'Markdown' }).catch(()=>{});
            await adminBot.answerCallbackQuery(query.id, { text: 'User upgraded to Premium!' });
        } else if (data.startsWith('reject_premium_')) {
            const userId = parseInt(data.split('_')[2]);
            const { getDB } = require('../db/schema');
            const client = getDB();
            
            // Send rejection message to user
            const { getBot } = require('./telegram');
            const mainBot = getBot();
            if (mainBot) {
                const userRes = await client.execute({ sql: 'SELECT telegram_id FROM users WHERE id = ?', args: [userId] });
                if (userRes.rows[0]) {
                    await mainBot.sendMessage(userRes.rows[0].telegram_id, '❌ *Payment Verification Failed*\n\nWe could not verify your Premium payment receipt. If you believe this is a mistake, please try uploading a clearer image of the receipt.', { parse_mode: 'Markdown' }).catch(()=>{});
                }
            }

            await adminBot.editMessageCaption(msg.caption + '\n\n❌ *Status: REJECTED*', { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'Markdown' }).catch(()=>{});
            await adminBot.answerCallbackQuery(query.id, { text: 'Receipt rejected.' });
        } else if (data.startsWith('delete_broadcast_')) {
            const bId = parseInt(data.split('_')[2]);
            await adminBot.answerCallbackQuery(query.id, { text: 'Starting deletion...' });
            await executeBroadcastDeletion(msg.chat.id, bId, null);
        } else if (data === 'broadcast_cancel') {
            const state = adminStates[query.from.id];
            if (state && state.action === 'broadcast') {
                try { await adminBot.deleteMessage(msg.chat.id, state.promptMsgId); } catch(e){}
                delete adminStates[query.from.id];
                await adminBot.sendMessage(msg.chat.id, '❌ Broadcast cancelled.');
            }
            await adminBot.answerCallbackQuery(query.id);
        } else if (data.startsWith('broadcast_finish_')) {
            const state = adminStates[query.from.id];
            if (!state || state.action !== 'broadcast') {
                return adminBot.answerCallbackQuery(query.id, { text: 'No active broadcast session.' });
            }

            const targetTier = data.replace('broadcast_finish_', '');
            const messages = state.messages;
            try { await adminBot.deleteMessage(msg.chat.id, state.promptMsgId); } catch(e){}
            delete adminStates[query.from.id];

            if (messages.length === 0) {
                await adminBot.sendMessage(msg.chat.id, '❌ You did not send any messages to broadcast.');
                return adminBot.answerCallbackQuery(query.id);
            }

            await adminBot.answerCallbackQuery(query.id, { text: 'Broadcasting started...' });
            const chatId = msg.chat.id;

            try {
                let users = await getAllUsers();
                if (targetTier === 'free') {
                    users = users.filter(u => Number(u.is_premium) === 0);
                } else if (targetTier === 'premium') {
                    users = users.filter(u => Number(u.is_premium) === 1);
                }

                let successCount = 0;
                let failCount = 0;

                const targetLabel = targetTier === 'all' ? 'Everyone' : (targetTier === 'free' ? 'Free Users' : 'Premium Users');
                await adminBot.sendMessage(chatId, `📢 Broadcasting ${messages.length} message(s) to ${users.length} users (${targetLabel})...`);

                const { getBot } = require('./telegram');
                const mainBot = getBot();

                if (!mainBot) {
                    await adminBot.sendMessage(chatId, '❌ Main bot is not running. Cannot broadcast.');
                    return;
                }

                // Generate comprehensive summary
                let textSnippet = '';
                const mediaCounts = { photo: 0, video: 0, voice: 0, document: 0 };
                for (const broadcastMsg of messages) {
                    if (!textSnippet && broadcastMsg.text) textSnippet = broadcastMsg.text.substring(0, 30);
                    if (!textSnippet && broadcastMsg.caption) textSnippet = broadcastMsg.caption.substring(0, 30);
                    if (broadcastMsg.photo) mediaCounts.photo++;
                    if (broadcastMsg.video) mediaCounts.video++;
                    if (broadcastMsg.voice) mediaCounts.voice++;
                    if (broadcastMsg.document) mediaCounts.document++;
                }

                let summaryParts = [];
                if (textSnippet) summaryParts.push(`"${textSnippet}..."`);
                if (mediaCounts.photo > 0) summaryParts.push(`[${mediaCounts.photo} Photo${mediaCounts.photo > 1 ? 's' : ''}]`);
                if (mediaCounts.video > 0) summaryParts.push(`[${mediaCounts.video} Video${mediaCounts.video > 1 ? 's' : ''}]`);
                if (mediaCounts.voice > 0) summaryParts.push(`[${mediaCounts.voice} Voice Note${mediaCounts.voice > 1 ? 's' : ''}]`);
                if (mediaCounts.document > 0) summaryParts.push(`[${mediaCounts.document} Document${mediaCounts.document > 1 ? 's' : ''}]`);
                
                let summaryText = summaryParts.join(' + ') || '[Empty/Unknown]';

                // Pre-download all buffers so we don't redownload per user
                const processedMedia = [];
                for (const broadcastMsg of messages) {
                    let fileUrl = null;
                    const captionText = broadcastMsg.text || broadcastMsg.caption || '';
                    const parseMode = { parse_mode: 'Markdown' };

                    if (broadcastMsg.photo) fileUrl = await adminBot.getFileLink(broadcastMsg.photo[broadcastMsg.photo.length - 1].file_id);
                    else if (broadcastMsg.voice) fileUrl = await adminBot.getFileLink(broadcastMsg.voice.file_id);
                    else if (broadcastMsg.video) fileUrl = await adminBot.getFileLink(broadcastMsg.video.file_id);
                    else if (broadcastMsg.document) fileUrl = await adminBot.getFileLink(broadcastMsg.document.file_id);

                    let fileBuffer = null;
                    let fileOptions = {};
                    if (fileUrl) {
                        try {
                            const response = await fetch(fileUrl);
                            fileBuffer = Buffer.from(await response.arrayBuffer());
                            if (broadcastMsg.document) fileOptions.filename = broadcastMsg.document.file_name || 'document.file';
                            if (broadcastMsg.video) fileOptions.filename = 'video.mp4';
                            if (broadcastMsg.voice) fileOptions.filename = 'voice.ogg';
                            if (broadcastMsg.photo) fileOptions.filename = 'photo.jpg';
                        } catch (e) {
                            console.error('Failed to download buffer for broadcast msg', e);
                        }
                    }
                    processedMedia.push({ msg: broadcastMsg, fileBuffer, captionText, parseMode, fileOptions });
                }

                // Create the broadcast record
                if (!summaryText) summaryText = '[Empty/Unknown]';
                const broadcastId = await createBroadcast(summaryText, query.from.id);

                for (const user of users) {
                    let userSuccess = true;
                    // Send every message to this user
                    for (const pm of processedMedia) {
                        try {
                            let sentMsg = null;
                            if (pm.msg.photo && pm.fileBuffer) {
                                sentMsg = await mainBot.sendPhoto(user.telegram_id, pm.fileBuffer, { caption: pm.captionText, ...pm.parseMode }, pm.fileOptions);
                            } else if (pm.msg.voice && pm.fileBuffer) {
                                sentMsg = await mainBot.sendVoice(user.telegram_id, pm.fileBuffer, { caption: pm.captionText, ...pm.parseMode }, pm.fileOptions);
                            } else if (pm.msg.video && pm.fileBuffer) {
                                sentMsg = await mainBot.sendVideo(user.telegram_id, pm.fileBuffer, { caption: pm.captionText, ...pm.parseMode }, pm.fileOptions);
                            } else if (pm.msg.document && pm.fileBuffer) {
                                sentMsg = await mainBot.sendDocument(user.telegram_id, pm.fileBuffer, { caption: pm.captionText, ...pm.parseMode }, pm.fileOptions);
                            } else if (pm.captionText) {
                                sentMsg = await mainBot.sendMessage(user.telegram_id, pm.captionText, pm.parseMode);
                            }
                            
                            if (sentMsg) {
                                // Log the message ID to the database so we can undo it later
                                await logBroadcastMessage(broadcastId, user.telegram_id, sentMsg.message_id);
                            }
                        } catch (e) {
                            userSuccess = false;
                        }
                    }
                    
                    if (userSuccess) successCount++;
                    else failCount++;
                    
                    // Rate limit to avoid Telegram spam block
                    await new Promise(r => setTimeout(r, 100));
                }

                const undoKeyboard = {
                    inline_keyboard: [[ { text: `🗑️ Undo Broadcast #${broadcastId}`, callback_data: `delete_broadcast_${broadcastId}` } ]]
                };

                await adminBot.sendMessage(chatId, `✅ **Broadcast #${broadcastId} Complete**\n📝 *Summary:* ${summaryText}\n━━━━━━━━━━━━━━━━━━━━\n• Delivered completely to: ${successCount}\n• Failed/Partial: ${failCount}`, { reply_markup: undoKeyboard, parse_mode: 'Markdown' });
            } catch (err) {
                console.error('Admin broadcast error:', err);
                await adminBot.sendMessage(chatId, '❌ Failed to broadcast.');
            }
        }
    });

    return adminBot;
}

// Helper to broadcast alerts to admins who want them in real-time
async function sendAdminAlert(messageText) {
    if (!globalAdminBot) return;
    try {
        const adminIds = await getAdminsForRealtimeNotifs();
        for (const id of adminIds) {
            try {
                await globalAdminBot.sendMessage(id, `🔔 *ALERT*\n\n${messageText}`, { parse_mode: 'Markdown' });
            } catch (e) {
                // Ignore if admin blocked the bot
            }
        }
    } catch (err) {
        console.error('Failed to send admin alert:', err);
    }
}

// Helper to forward premium receipts to admin
async function forwardPremiumReceipt(userId, businessName, telegramUsername, telegramId, photoBuffer) {
    if (!globalAdminBot) return;
    const adminId = process.env.MASTER_ADMIN_ID;
    try {
        await globalAdminBot.sendPhoto(adminId, photoBuffer, {
            caption: `💳 *Premium Payment Verification*\n\nUser: ${businessName} (${telegramUsername ? '@'+telegramUsername : 'No username'})\nTelegram ID: \`${telegramId}\`\n\nPlease verify the receipt and approve.`,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Approve Premium', callback_data: `approve_premium_${userId}` },
                        { text: '❌ Reject', callback_data: `reject_premium_${userId}` }
                    ]
                ]
            }
        }, { filename: 'receipt.jpg', contentType: 'image/jpeg' });
    } catch (e) {
        console.error("Failed to forward premium receipt:", e);
    }
}

module.exports = { startAdminBot, sendAdminAlert, forwardPremiumReceipt };
