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

Your job is threefold:
1. Extract NEW transaction data from the user's message.
2. Answer any conversational QUESTIONS the user asks about their recent transactions, using the provided history.
3. Handle EDIT or DELETE requests when the user wants to modify existing records.

RULES FOR EXTRACTION:
1. Extract EVERY NEW transaction mentioned. Do NOT extract transactions that are already in the "Recent Transactions" history unless the user explicitly tells you to log it again.
2. Categorize each as "income" or "expense"
3. Assign a category from this expanded list:
   INCOME CATEGORIES: Product Sales, Service Revenue, Catering, Food Sales, Retail Sales, Consulting, Commission, Rental Income, Other Income
   COST OF GOODS / PROCUREMENT: Raw Materials, Stock Purchase, Inventory, Packaging, Supplies
   OPERATING EXPENSES: Transport, Loading/Haulage, Staff/Wages, Rent, Utilities, Generator/Fuel, Electricity, Marketing/Advertising, Communication/Data, Delivery Fees, Equipment, Maintenance, Insurance
   FINANCIAL EXPENSES: Debt Payment, Bank Charges, Interest, Loan Repayment
   OTHER: Other Expense
4. For Nigerian context: understand Pidgin English, local references (e.g., "naira", "k" = thousand, "beg" = discount, "dash" = free/gift)
5. Use today's date unless a specific date is mentioned. Understand relative dates: "yesterday", "last Friday", "Monday", "last week"
6. Extract payment method when mentioned. Options: "cash", "transfer", "POS", "unknown". Look for clues: "they sent me", "I received alert" = transfer. "cash", "physical" = cash. "POS", "card" = POS.

RULES FOR Q&A:
1. If the user asks a question (e.g., "how much okpa did I sell?", "did I log transport?"), look at the "Recent Transactions" context.
2. Calculate the answer based ONLY on the context provided.
3. Write your answer in a friendly, conversational tone in the "summary" field.

RULES FOR EDIT/DELETE:
1. If the user wants to CHANGE an existing transaction (e.g., "change Friday's transport from 2000 to 2500", "update yesterday's sale to 15000", "the electricity was actually 3000 not 2000"), set action to "edit".
2. If the user wants to DELETE a transaction (e.g., "remove the transport entry from Monday", "delete yesterday's electricity expense"), set action to "delete".
3. For edits/deletes, fill in the "edit_target" field with enough detail to find the transaction.

RULES FOR CONVERSATIONAL MESSAGES:
1. If the user sends a confirmation like "correct", "all correct", "yes", "ok", "perfect", "nice", "good", "right", "that's right", respond warmly - e.g., "Great, glad I got everything right!  Keep sending your transactions whenever you're ready."
2. If the user sends a greeting like "hi", "hello", "hey", "good morning", respond naturally - e.g., "Hey!  Ready to log today's transactions. Just send me your sales and expenses!"
3. If the user says "thank you", "thanks", "appreciate it", respond warmly - e.g., "You're welcome!  I'm always here to help."
4. If the user sends something unrelated to business/finances (random chat), respond briefly and steer back - e.g., "Haha, noted!  But let's keep track of the money - tell me about today's sales or expenses!"
5. NEVER respond with a generic "I couldn't find any transaction data" to conversational messages. Always be natural and context-aware.

RESPOND ONLY WITH VALID JSON in this exact format:
{
  "action": "log" or "edit" or "delete" or "query" or "chat",
  "transactions": [
    {
      "type": "income" or "expense",
      "category": "category name",
      "amount": number,
      "description": "brief description",
      "payment_method": "cash" or "transfer" or "POS" or "unknown",
      "date": "YYYY-MM-DD or null for today"
    }
  ],
  "edit_target": {
    "date": "YYYY-MM-DD or null",
    "description": "keyword to match",
    "category": "category to match or null",
    "old_amount": number or null,
    "new_amount": number or null,
    "new_description": "new description or null",
    "new_category": "new category or null"
  },
  "summary": "A friendly confirmation of what was recorded, OR the answer to the user's question, OR a natural conversational reply.",
  "clarification_needed": null or "A question to ask the user if critical info is missing (e.g., missing date on a receipt)"
}

IMPORTANT: For "log" actions, always include transactions array. For "edit"/"delete" actions, always include edit_target. For "query"/"chat" actions, transactions should be [].
If the message genuinely seems like it should contain financial data but you can't parse it, set action to "chat", transactions to [] and write a helpful summary asking for clarification - but do NOT include example prompts like 'Try: I sold...'. Just ask them naturally what they sold or spent.`;

// ============ BANK STATEMENT / DOCUMENT PROMPT ============
const DOCUMENT_PROMPT = `You are Kobowise, an AI financial assistant for Nigerian small businesses.

The user has uploaded a document (bank statement, receipt, or financial record). Your job is to extract ALL transactions from this document.

IMPORTANT PRIVACY RULES:
1. IGNORE all personal identifiers: account numbers, BVN, session IDs, phone numbers, email addresses
2. Focus ONLY on: transaction dates, descriptions/narrations, amounts, and whether each is credit (income) or debit (expense)
3. DO NOT include any customer names, account details, or bank identifiers in your output

EXTRACTION RULES:
1. Extract EVERY transaction you can find
2. For bank statements: Credits/Deposits = "income", Debits/Withdrawals = "expense"
3. Categorize based on the narration/description:
   - "Transfer from..." / "Credit" / "Deposit" → check narration for business context
   - "POS" / "Web Payment" → likely expense
   - "Airtime" / "Data" → Communication/Data expense
   - "Fuel" / "Petrol" → Generator/Fuel expense
   - Look for patterns in narrations that suggest business vs personal transactions
4. Extract payment method: "transfer", "POS", "cash", or "unknown"
5. Use the date from the statement, NOT today's date
6. If something looks like a personal transaction (not business-related), still include it but note it in the description

RESPOND ONLY WITH VALID JSON:
{
  "action": "log",
  "transactions": [
    {
      "type": "income" or "expense",
      "category": "category name",
      "amount": number,
      "description": "brief description from narration",
      "payment_method": "transfer" or "POS" or "cash" or "unknown",
      "date": "YYYY-MM-DD"
    }
  ],
  "summary": "Summary of what was found - e.g., 'Found 15 transactions from your OPay statement (Jan 5-20). 8 credits totaling ₦45,000 and 7 debits totaling ₦23,500. Please review and confirm!'"
}`;

// ============ PROCESS TEXT INPUT ============
async function processTextInput(text, businessType, recentTransactionsContext = '') {
    const today = new Date().toISOString().split('T')[0];
    const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    
    const prompt = `Business type: ${businessType || 'General'}
Today's date: ${today} (${dayOfWeek})

Recent Transactions (for answering questions and matching edits):
${recentTransactionsContext || 'No recent transactions.'}

User message:
"${text}"`;

    try {
        return await executeWithFailover('text', { systemPrompt: EXTRACTION_PROMPT, prompt });
    } catch (err) {
        return { action: 'chat', transactions: [], summary: 'Something went wrong processing your message. Please try again later.' };
    }
}

// ============ PROCESS IMAGE (OCR) ============
async function processImage(images, businessType, recentTransactionsContext = '') {
    // Convert a single image args object to an array to handle both single and multiple
    const imagesArray = Array.isArray(images) ? images : [images];
    const today = new Date().toISOString().split('T')[0];
    
    const prompt = `Business type: ${businessType || 'General'}
Today's date: ${today}

Recent Transactions (for answering questions):
${recentTransactionsContext || 'No recent transactions.'}

The user sent ${imagesArray.length} photo(s). These could be:
- Handwritten sales notebook pages (common in Nigerian markets - ruled paper with pen entries)
- Printed POS receipts or bank transfer receipts
- Custom business receipts with logo and items
- Screenshots of mobile banking transfer confirmations

Extract ALL transaction data you can see across ALL these images.
If the handwriting is unclear, do your best and note uncertainty in the description.
If NO DATE is visible on the receipt/image, set clarification_needed to ask the user what date this was from.
Look for payment method clues: "TRANSFER", "POS", "CASH" etc.`;

    try {
        const parts = [EXTRACTION_PROMPT, prompt];
        
        for (const img of imagesArray) {
            parts.push({
                inlineData: {
                    data: img.buffer.toString('base64'),
                    mimeType: img.mimeType
                }
            });
        }
        
        // Use Gemini direct via SDK for array of parts
        const genAI = new GoogleGenerativeAI(getGeminiKeys()[0]);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const result = await model.generateContent(parts);
        const responseText = result.response.text();
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found');
        return JSON.parse(jsonMatch[0]);
    } catch (err) {
        console.error('Multi-image processing error:', err.message);
        return { action: 'chat', transactions: [], summary: 'Something went wrong reading your photo(s). Please try again later.' };
    }
}

// ============ PROCESS IMAGE PDF ============
async function processImagePDF(pdfBuffer, businessType, recentTransactionsContext = '') {
    const today = new Date().toISOString().split('T')[0];
    
    const prompt = `Business type: ${businessType || 'General'}
Today's date: ${today}

The user sent a PDF document that appears to be scanned images (no text layer). 
Please extract all transactions you can see.
Note: Since this is an image, we could not automatically redact sensitive info. Please DO NOT include account numbers, BVNs, or customer names in the extracted data.`;

    try {
        const parts = [
            EXTRACTION_PROMPT,
            prompt,
            {
                inlineData: {
                    data: pdfBuffer.toString('base64'),
                    mimeType: 'application/pdf'
                }
            }
        ];
        
        const genAI = new GoogleGenerativeAI(getGeminiKeys()[0]);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const result = await model.generateContent(parts);
        const responseText = result.response.text();
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found');
        return JSON.parse(jsonMatch[0]);
    } catch (err) {
        console.error('Image PDF processing error:', err.message);
        return { action: 'chat', transactions: [], summary: 'Something went wrong processing your PDF. Please try again later.' };
    }
}

// ============ PROCESS VOICE NOTE ============
async function processVoiceNote(audioBuffer, mimeType, businessType, recentTransactionsContext = '') {
    const today = new Date().toISOString().split('T')[0];
    const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    
    const prompt = `Business type: ${businessType || 'General'}
Today's date: ${today} (${dayOfWeek})

Recent Transactions (for answering questions):
${recentTransactionsContext || 'No recent transactions.'}

The user sent a voice note describing their business day. 
Listen carefully - they may speak in English, Pidgin, or a mix.
Extract ALL financial transactions mentioned.
Pay attention to payment methods mentioned: "them send me money" = transfer, "cash" = cash, etc.
Pay attention to dates mentioned: "yesterday", "last Friday", "on Monday" etc.`;

    try {
        return await executeWithFailover('audio', { systemPrompt: EXTRACTION_PROMPT, prompt, audioBuffer, mimeType });
    } catch (err) {
        return { action: 'chat', transactions: [], summary: 'Something went wrong processing your voice note. Please try again later.' };
    }
}

// ============ PROCESS DOCUMENT (PDF/BANK STATEMENT) ============
async function processDocument(textContent, businessType, recentTransactionsContext = '') {
    const prompt = `Business type: ${businessType || 'General'}

Document content (extracted from PDF - sensitive data has been partially redacted):
---
${textContent.substring(0, 15000)}
---

${textContent.length > 15000 ? `\n[Note: Document was truncated. Only first 15000 characters shown. There may be more transactions.]` : ''}`;

    try {
        return await executeWithFailover('text', { systemPrompt: DOCUMENT_PROMPT, prompt });
    } catch (err) {
        return { action: 'chat', transactions: [], summary: 'Something went wrong processing your document. Please try again later.' };
    }
}

// ============ GENERATE HEALTH REPORT ============
const HEALTH_REPORT_PROMPT = `You are Kobowise, an AI Business Doctor for Nigerian small businesses.
Generate a "Business Health Report" for this week.

STYLE: Write like a caring doctor, not an accountant. Be specific with naira amounts.
Use emojis. Give actionable advice. Speak plainly - no jargon.

Include analysis of:
- Revenue vs Expense trends
- Profit margin health
- Top expense drivers (cost drivers)
- Cash flow pattern
- Payment method breakdown if available
- Specific, actionable prescriptions

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
    const msg = ` ${businessName.toUpperCase()} - Weekly Health Report\n━━━━━━━━━━━━━━━━━━━━━━\n\n DIAGNOSIS\n\n Revenue: ₦${summary.revenue.toLocaleString()}\n Expenses: ₦${summary.expenses.toLocaleString()}\n Profit: ₦${summary.profit.toLocaleString()} (${summary.margin}% margin)\n\n${summary.profit > 0 ? '✅ You\'re in profit this week!' : '⚠ You spent more than you earned this week.'}\n\n━━━━━━━━━━━━━━━━━━━━━━\nReply "more" for detailed breakdown`;

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
    processDocument,
    processImagePDF,
    generateHealthReport
};
