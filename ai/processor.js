const { GoogleGenerativeAI } = require('@google/generative-ai');
const { OpenAI, toFile } = require('openai');

function getGeminiKeys() {
    return Object.keys(process.env)
        .filter(k => k.startsWith('GEMINI_API_KEY'))
        .map(k => process.env[k])
        .filter(k => k && k !== 'your_gemini_api_key_here');
}

function getGroqKeys() {
    return Object.keys(process.env)
        .filter(k => k.startsWith('GROQ_API_KEY'))
        .map(k => process.env[k])
        .filter(k => k);
}

async function executeGemini(key, taskType, args) {
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    let result, response;
    const fullPrompt = `${args.systemPrompt}\n\n${args.prompt}`;
    
    if (taskType === 'text' || taskType === 'report') {
        result = await model.generateContent(fullPrompt);
    } else if (taskType === 'image') {
        const imagePart = { inlineData: { data: args.imageBuffer.toString('base64'), mimeType: args.mimeType || 'image/jpeg' } };
        result = await model.generateContent([fullPrompt, imagePart]);
    } else if (taskType === 'audio') {
        const audioPart = { inlineData: { data: args.audioBuffer.toString('base64'), mimeType: args.mimeType || 'audio/ogg' } };
        result = await model.generateContent([fullPrompt, audioPart]);
    }
    
    response = result.response.text();
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in Gemini output');
    return JSON.parse(jsonMatch[0]);
}

async function executeGroq(key, taskType, args) {
    const groq = new OpenAI({ apiKey: key, baseURL: 'https://api.groq.com/openai/v1' });
    
    if (taskType === 'text' || taskType === 'report' || taskType === 'image') {
        let content;
        let model = 'llama-3.3-70b-versatile'; // Fallback text model
        
        if (taskType === 'image') {
            model = 'llama-3.2-90b-vision-preview';
            content = [
                { type: 'text', text: args.prompt },
                { type: 'image_url', image_url: { url: `data:${args.mimeType || 'image/jpeg'};base64,${args.imageBuffer.toString('base64')}` } }
            ];
        } else {
            content = args.prompt;
        }

        const response = await groq.chat.completions.create({
            model: model,
            messages: [
                { role: 'system', content: args.systemPrompt },
                { role: 'user', content: content }
            ],
            response_format: { type: 'json_object' },
            temperature: 0.1
        });
        
        const text = response.choices[0].message.content;
        return JSON.parse(text);
    } else if (taskType === 'audio') {
        // Groq audio uses Whisper to transcribe, then Llama to extract
        const file = await toFile(args.audioBuffer, 'audio.ogg', { type: args.mimeType || 'audio/ogg' });
        const transcription = await groq.audio.transcriptions.create({
            file: file,
            model: 'whisper-large-v3'
        });
        
        const transcript = transcription.text;
        const textPrompt = args.prompt + '\n\nTranscript:\n' + transcript;
        
        const response = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [
                { role: 'system', content: args.systemPrompt },
                { role: 'user', content: textPrompt }
            ],
            response_format: { type: 'json_object' },
            temperature: 0.1
        });
        
        const text = response.choices[0].message.content;
        return JSON.parse(text);
    }
}

async function executeWithFailover(taskType, args) {
    const allKeys = [
        ...getGeminiKeys().map(k => ({ provider: 'gemini', key: k })),
        ...getGroqKeys().map(k => ({ provider: 'groq', key: k }))
    ];

    if (allKeys.length === 0) {
        throw new Error('No valid API keys configured for Gemini or Groq.');
    }

    let lastError = null;

    for (const cred of allKeys) {
        try {
            console.log(`[AI] Attempting ${taskType} using ${cred.provider}...`);
            if (cred.provider === 'gemini') {
                return await executeGemini(cred.key, taskType, args);
            } else if (cred.provider === 'groq') {
                return await executeGroq(cred.key, taskType, args);
            }
        } catch (err) {
            console.error(`[AI] ${cred.provider} key failed:`, err.message);
            lastError = err;
            // Continue to the next key automatically
        }
    }

    throw new Error(`All AI providers failed. Last error: ${lastError.message}`);
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
    const prompt = `Business type: ${businessType || 'General'}\n\nRecent Transactions (for answering questions):\n${recentTransactionsContext || 'No recent transactions.'}\n\nUser message:\n"${text}"`;

    try {
        return await executeWithFailover('text', { systemPrompt: EXTRACTION_PROMPT, prompt });
    } catch (err) {
        return { transactions: [], summary: 'Something went wrong processing your message. Please try again later.' };
    }
}

// ============ PROCESS IMAGE (OCR) ============
async function processImage(imageBuffer, mimeType, businessType, recentTransactionsContext = '') {
    const prompt = `Business type: ${businessType || 'General'}\n\nRecent Transactions (for answering questions):\n${recentTransactionsContext || 'No recent transactions.'}\n\nThe user sent a photo of their sales notebook, receipt, or financial record. \nExtract ALL transaction data you can see in the image.\nIf the handwriting is unclear, do your best and note uncertainty in the description.`;

    try {
        return await executeWithFailover('image', { systemPrompt: EXTRACTION_PROMPT, prompt, imageBuffer, mimeType });
    } catch (err) {
        return { transactions: [], summary: 'Something went wrong reading your photo. Please try again later.' };
    }
}

// ============ PROCESS VOICE NOTE ============
async function processVoiceNote(audioBuffer, mimeType, businessType, recentTransactionsContext = '') {
    const prompt = `Business type: ${businessType || 'General'}\n\nRecent Transactions (for answering questions):\n${recentTransactionsContext || 'No recent transactions.'}\n\nThe user sent a voice note describing their business day. \nListen carefully — they may speak in English, Pidgin, or a mix.\nExtract ALL financial transactions mentioned.`;

    try {
        return await executeWithFailover('audio', { systemPrompt: EXTRACTION_PROMPT, prompt, audioBuffer, mimeType });
    } catch (err) {
        return { transactions: [], summary: 'Something went wrong processing your voice note. Please try again later.' };
    }
}

// ============ GENERATE HEALTH REPORT ============
const HEALTH_REPORT_PROMPT = `You are Kobowise, an AI Business Doctor for Nigerian small businesses.
Generate a "Business Health Report" for this week.

STYLE: Write like a caring doctor, not an accountant. Be specific with naira amounts.
Use emojis. Give actionable advice. Speak plainly — no jargon.

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

async function generateHealthReport(summary, businessName, businessType, previousReport) {
    const prompt = `BUSINESS: ${businessName} (${businessType})

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

${previousReport ? `LAST WEEK: Revenue ₦${previousReport.revenue?.toLocaleString()}, Expenses ₦${previousReport.expenses?.toLocaleString()}` : 'This is the first report.'}`;

    try {
        return await executeWithFailover('report', { systemPrompt: HEALTH_REPORT_PROMPT, prompt });
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
