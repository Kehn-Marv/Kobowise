# Kobowise 🩺 

**Kobowise** is an AI-powered "Business Doctor" built entirely on Telegram for Nigerian SMEs and business owners. It allows users to track their daily sales and expenses without needing any accounting knowledge. Users can simply type, send a voice note (in English or Pidgin), or snap a picture of a receipt, and Kobowise's AI will automatically categorize and log the transaction.

Every Sunday, Kobowise generates a comprehensive "Health Report" that analyzes the business's financials and offers AI-driven prescriptions for growth.

## 🚀 Features

### For Users (The Main Bot)
- **Multi-Modal Input:** Log transactions by sending Text, Voice Notes, or Photos.
- **Native AI Integration:** Powered by Google Gemini (Vision & Audio) to seamlessly extract financial data from unstructured natural inputs.
- **Pidgin Support:** Users can speak or type in Nigerian Pidgin, and the AI understands perfectly.
- **Weekly Health Reports:** Automated cron jobs that send detailed financial analysis and profit margins every Sunday at 6 PM WAT.
- **Data Export:** Generate and download a `.csv` file of all lifetime transactions.
- **Premium Tier:** A freemium model with daily limits, offering unlimited usage and advanced insights for Premium subscribers.

### For Owners (The Admin Bot)
A completely separate, secured Telegram bot built exclusively for platform management.
- **Silent Security Access Control:** Only whitelisted Telegram IDs can interact with the bot. Unauthorized users are ignored entirely.
- **God-Mode Analytics:** View real-time platform statistics including total users, 24h active users, top regions, and input methods (Voice vs Photo vs Text).
- **Multi-Media Broadcasts:** Queue up texts, photos, and voice notes into a "Collection Session" and blast them to all users at once.
- **Undo Broadcasts:** Accidentally sent a typo? The bot tracks every single `message_id` and allows you to recall/undo broadcasts from all users' phones up to 48 hours later.
- **Real-time Alerts:** Configurable notification preferences. Get instantly pinged the moment a new user finishes onboarding.
- **Dynamic Settings:** A sleek, callback-driven inline keyboard for managing your admin preferences.

---

## 🛠️ Tech Stack

- **Backend:** Node.js, Express.js
- **Bot Framework:** `node-telegram-bot-api` (Polling mode)
- **Database:** SQLite (using `@libsql/client` for fast, edge-ready queries)
- **AI Processing:** `@google/genai` (Gemini 2.0 Flash)
- **Frontend Dashboard:** Vanilla HTML/CSS/JS (served via Express)

---

## 💻 Local Development Setup

### Prerequisites
- Node.js (v18+ recommended)
- A Google Gemini API Key
- Two Telegram Bot Tokens (Create them via [@BotFather](https://t.me/botfather) on Telegram)

### 1. Clone & Install
```bash
git clone https://github.com/yourusername/kobowise.git
cd kobowise
npm install
```

### 2. Environment Variables
Copy the `.env.example` file to `.env`:
```bash
cp .env.example .env
```
Fill in your API keys and tokens:
```env
TELEGRAM_BOT_TOKEN="your_main_bot_token"
ADMIN_BOT_TOKEN="your_admin_bot_token"
GEMINI_API_KEY="your_gemini_api_key"

# Add your personal Telegram ID here to become the Master Admin
MASTER_ADMIN_ID="your_telegram_id"
```

### 3. Run the Server
```bash
npm run dev
```
You should see:
```text
✅ Database initialized
🤖 Telegram bot is listening...
✅ Telegram main bot started
🛡️ Admin bot started on polling mode
✅ Telegram admin bot started
```

---

## 📱 Bot Commands

### Main Bot Commands
Register these in BotFather for your main bot:
- `report` - Get your latest health report
- `balance` - View today's and all-time financials
- `status` - Check your usage and plan
- `export` - Download your data as a CSV file
- `settings` - Change language, notifications, and name
- `cancel` - Undo your last entry or reset state
- `premium` - View upgrade options
- `help` - Show the help menu
- `start` - Restart onboarding

### Admin Bot Commands
Register these in BotFather for your admin bot:
- `stats` - View detailed metrics and usage
- `users` - List registered users
- `broadcast` - Send a message or media to all users
- `broadcasts` - View your recent broadcasts and IDs
- `deletebroadcast` - Recall a sent broadcast
- `admins` - List authorized admins
- `addadmin` - Grant access to a new user
- `removeadmin` - Revoke access from a user
- `settings` - Configure your notification preferences
- `help` - View all available commands

---

## 🏗️ Architecture Notes
- `db/schema.js` acts as the single source of truth for the database connection and queries.
- `bot/telegram.js` handles the main user flow and Gemini processing.
- `bot/admin.js` handles the secured admin panel and broadcast queueing.
- The `kobo.db` file is generated automatically upon running the server. Do not commit this file to version control.
- Because the bots use long-polling, this app requires a persistent, long-running Node server (e.g., Render, Railway, DigitalOcean) and **cannot** be deployed to serverless environments like Vercel without migrating to webhooks.
