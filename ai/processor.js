const { GoogleGenerativeAI } = require('@google/generative-ai');

let genAI = null;
let model = null;

function getModel() {
    if (model) return model;

    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_gemini_api_key_here') {
        throw new Error('GEMINI_API_KEY not configured. Get a free key at https://aistudio.google.com/apikey');
    }

    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    return model;
}

// ============ SYSTEM PROMPT ============
const EXTRACTION_PROMPT = `You are Kobowise, an AI financial assistant for Nigerian small businesses.

Your job is twofold:
1. Extract NEW transaction data from the user's message.
2. Answer any conversational QUESTIONS the user asks about their recent transactions, using the provided history.

RULES FOR EXTRACTION:
1. Extract EVERY NEW transaction mentioned. Do NOT extract transactions that are already in the "Recent Transactions" history unless the user explicitly tells you to log it again.
2. Categorize each as "income" or "expense"
3. Assign a category from: Food Sales, Retail Sales, Services, Catering, Supplies, Raw Materials, Transport, Staff, Utilities, Rent, Debt Payment, Equipment, Marketing, Other Income, Other Expense
4. For Nigerian context: understand Pidgin English, local references (e.g., "naira", "k" = thousand, "beg" = discount)
5. Use today's date unless a specific date is mentioned

RULES FOR Q&A:
1. If the user asks a question (e.g., "how much okpa did I sell?", "did I log transport?"), look at the "Recent Transactions" context.
2. Calculate the answer based ONLY on the context provided.
3. Write your answer in a friendly, conversational tone in the "summary" field.

RULES FOR CONVERSATIONAL MESSAGES:
1. If the user sends a confirmation like "correct", "all correct", "yes", "ok", "perfect", "nice", "good", "right", "that's right", respond warmly — e.g., "Great, glad I got everything right! 👍 Keep sending your transactions whenever you're ready."
2. If the user sends a greeting like "hi", "hello", "hey", "good morning", respond naturally — e.g., "Hey! 👋 Ready to log today's transactions. Just send me your sales and expenses!"
3. If the user says "thank you", "thanks", "appreciate it", respond warmly — e.g., "You're welcome! 😊 I'm always here to help."
4. If the user sends something unrelated to business/finances (random chat), respond briefly and steer back — e.g., "Haha, noted! 😄 But let's keep track of the money — tell me about today's sales or expenses!"
5. NEVER respond with a generic "I couldn't find any transaction data" to conversational messages. Always be natural and context-aware.

RESPOND ONLY WITH VALID JSON in this exact format:
{
  "transactions": [
    {
      "type": "income" or "expense",
      "category": "category name",
      "amount": number,
      "description": "brief description"
    }
  ],
  "summary": "A friendly confirmation of what was recorded, OR the answer to the user's question, OR a natural conversational reply."
}

If the message genuinely seems like it should contain financial data but you can't parse it, set transactions to [] and write a helpful summary asking for clarification — but do NOT include example prompts like 'Try: I sold...'. Just ask them naturally what they sold or spent.`;

// ============ PROCESS TEXT INPUT ============
async function processTextInput(text, businessType, recentTransactionsContext = '') {
    const ai = getModel();

    const prompt = `${EXTRACTION_PROMPT}

Business type: ${businessType || 'General'}

Recent Transactions (for answering questions):
${recentTransactionsContext || 'No recent transactions.'}

User message:
"${text}"`;

    try {
        const result = await ai.generateContent(prompt);
        const response = result.response.text();

        // Extract JSON from response (handle markdown code blocks)
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return { transactions: [], summary: 'Sorry, I had trouble understanding that. Could you try again?' };
        }

        return JSON.parse(jsonMatch[0]);
    } catch (err) {
        console.error('AI processing error:', err.message);
        return { transactions: [], summary: 'Something went wrong processing your message. Please try again.' };
    }
}

// ============ PROCESS IMAGE (OCR) ============
async function processImage(imageBuffer, mimeType, businessType, recentTransactionsContext = '') {
    const ai = getModel();

    const prompt = `${EXTRACTION_PROMPT}

Business type: ${businessType || 'General'}

Recent Transactions (for answering questions):
${recentTransactionsContext || 'No recent transactions.'}

The user sent a photo of their sales notebook, receipt, or financial record. 
Extract ALL transaction data you can see in the image.
If the handwriting is unclear, do your best and note uncertainty in the description.`;

    try {
        const imagePart = {
            inlineData: {
                data: imageBuffer.toString('base64'),
                mimeType: mimeType || 'image/jpeg'
            }
        };

        const result = await ai.generateContent([prompt, imagePart]);
        const response = result.response.text();

        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return { transactions: [], summary: 'I couldn\'t read the image clearly. Try taking a clearer photo with good lighting.' };
        }

        return JSON.parse(jsonMatch[0]);
    } catch (err) {
        console.error('Image processing error:', err.message);
        return { transactions: [], summary: 'Something went wrong reading your photo. Please try again.' };
    }
}

// ============ PROCESS VOICE NOTE ============
async function processVoiceNote(audioBuffer, mimeType, businessType, recentTransactionsContext = '') {
    const ai = getModel();

    const prompt = `${EXTRACTION_PROMPT}

Business type: ${businessType || 'General'}

Recent Transactions (for answering questions):
${recentTransactionsContext || 'No recent transactions.'}

The user sent a voice note describing their business day. 
Listen carefully — they may speak in English, Pidgin, or a mix.
Extract ALL financial transactions mentioned.`;

    try {
        const audioPart = {
            inlineData: {
                data: audioBuffer.toString('base64'),
                mimeType: mimeType || 'audio/ogg'
            }
        };

        const result = await ai.generateContent([prompt, audioPart]);
        const response = result.response.text();

        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return { transactions: [], summary: 'I couldn\'t understand the voice note clearly. Try speaking a bit clearer or typing it out.' };
        }

        return JSON.parse(jsonMatch[0]);
    } catch (err) {
        console.error('Voice processing error:', err.message);
        return { transactions: [], summary: 'Something went wrong processing your voice note. Please try again.' };
    }
}

// ============ GENERATE HEALTH REPORT ============
async function generateHealthReport(summary, businessName, businessType, previousReport) {
    const ai = getModel();

    const prompt = `You are Kobowise, an AI Business Doctor for Nigerian small businesses.
Generate a "Business Health Report" for this week.

STYLE: Write like a caring doctor, not an accountant. Be specific with naira amounts.
Use emojis. Give actionable advice. Speak plainly — no jargon.

BUSINESS: ${businessName} (${businessType})

THIS WEEK'S DATA:
- Total Revenue: ₦${summary.revenue.toLocaleString()}
- Total Expenses: ₦${summary.expenses.toLocaleString()}
- Profit: ₦${summary.profit.toLocaleString()} (${summary.margin}% margin)
- Transaction count: ${summary.transaction_count}

EXPENSE CATEGORIES:
${summary.categories
    .filter(c => c.type === 'expense')
    .map(c => `- ${c.category}: ₦${Number(c.total).toLocaleString()} (${c.count} transactions)`)
    .join('\n')}

INCOME CATEGORIES:
${summary.categories
    .filter(c => c.type === 'income')
    .map(c => `- ${c.category}: ₦${Number(c.total).toLocaleString()} (${c.count} transactions)`)
    .join('\n')}

DAILY BREAKDOWN:
${summary.daily.map(d => `- ${d.date}: ${d.type} ₦${Number(d.total).toLocaleString()}`).join('\n')}

${previousReport ? `LAST WEEK: Revenue ₦${previousReport.revenue?.toLocaleString()}, Expenses ₦${previousReport.expenses?.toLocaleString()}` : 'This is the first report.'}

RESPOND IN THIS JSON FORMAT:
{
  "telegram_message": "The full report formatted for Telegram (use text formatting, emojis, line breaks with \\n)",
  "notes": [
    {
      "type": "warning" or "success" or "tip",
      "badge": "emoji + short label",
      "text": "The observation",
      "prescription": "optional specific fix with naira amounts"
    }
  ],
  "headline": "One-line summary of the week"
}`;

    try {
        const result = await ai.generateContent(prompt);
        const response = result.response.text();

        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return generateFallbackReport(summary, businessName);
        }

        return JSON.parse(jsonMatch[0]);
    } catch (err) {
        console.error('Report generation error:', err.message);
        return generateFallbackReport(summary, businessName);
    }
}

// ============ FALLBACK REPORT ============
function generateFallbackReport(summary, businessName) {
    const msg = `📋 ${businessName.toUpperCase()} — Weekly Health Report\n━━━━━━━━━━━━━━━━━━━━━━\n\n🏥 DIAGNOSIS\n\n💰 Revenue: ₦${summary.revenue.toLocaleString()}\n💸 Expenses: ₦${summary.expenses.toLocaleString()}\n📊 Profit: ₦${summary.profit.toLocaleString()} (${summary.margin}% margin)\n\n${summary.profit > 0 ? '✅ You\'re in profit this week!' : '⚠️ You spent more than you earned this week.'}\n\n━━━━━━━━━━━━━━━━━━━━━━\nReply "more" for detailed breakdown`;

    return {
        telegram_message: msg,
        notes: [],
        headline: summary.profit > 0 ? 'Profitable week!' : 'Expenses exceeded revenue'
    };
}

module.exports = {
    processTextInput,
    processImage,
    processVoiceNote,
    generateHealthReport
};
