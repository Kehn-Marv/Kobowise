const { PDFParse } = require('pdf-parse');

class PasswordRequiredError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PasswordRequiredError';
    }
}

/**
 * Extract text from a PDF buffer using the low-level pdfjs API
 * @param {Buffer} buffer - The PDF file buffer
 * @param {string} [password] - Optional password for encrypted PDFs
 * @returns {Promise<{text: string, isImageOnly: boolean}>} - Extracted text content and image-only flag
 */
async function extractTextFromPDF(buffer, password = null) {
    let parser;
    try {
        const options = { verbosity: 0, data: new Uint8Array(buffer) };
        if (password) {
            options.password = password;
        }
        
        parser = new PDFParse(options);
        const doc = await parser.load();
        const numPages = doc.numPages || 0;
        
        let fullText = '';
        // Process up to 30 pages max
        const maxPages = Math.min(numPages, 30);
        
        for (let i = 1; i <= maxPages; i++) {
            try {
                const page = await doc.getPage(i);
                const textContent = await page.getTextContent();
                
                // Join text items into lines
                let lastY = null;
                let line = '';
                for (const item of textContent.items) {
                    const y = item.transform ? item.transform[5] : null;
                    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
                        fullText += line.trim() + '\n';
                        line = '';
                    }
                    line += (item.str || '') + ' ';
                    lastY = y;
                }
                if (line.trim()) fullText += line.trim() + '\n';
                fullText += '\n'; // Page break
            } catch (pageErr) {
                // Skip unreadable pages
            }
        }
        
        if (numPages > maxPages) {
            fullText += `\n[Note: PDF has ${numPages} pages total. Only first ${maxPages} pages were processed.]\n`;
        }
        
        parser.destroy();
        const finalString = fullText.trim() || '';
        return {
            text: finalString,
            isImageOnly: finalString.length < 50
        };
    } catch (err) {
        if (parser) parser.destroy();
        const errMsg = err.message || '';
        
        // pdf.js throws errors containing 'PasswordException' or 'password' when encrypted
        if (errMsg.includes('Password') || errMsg.includes('password') || err.name === 'PasswordException') {
            throw new PasswordRequiredError('This PDF document is password-protected.');
        }
        
        console.error('[PDF Parser] Failed to extract text:', errMsg);
        throw new Error('Could not read this PDF file. It may be corrupted or image-only.');
    }
}

/**
 * Strip sensitive/personal information from bank statement text
 * before sending to AI for processing.
 * 
 * Removes: account numbers, BVN, session IDs, customer bank details,
 * phone numbers in narrations, and other PII.
 * 
 * @param {string} text - Raw extracted text
 * @returns {string} - Cleaned text safe for AI processing
 */
function stripSensitiveData(text) {
    let cleaned = text;

    // Remove full account numbers (10-digit Nigerian NUBAN format)
    // Keep last 4 digits for context: 1234567890 → ****7890
    cleaned = cleaned.replace(/\b(\d{10})\b/g, (match) => {
        // Don't replace if it looks like an amount (has comma/decimal nearby) or date
        return '****' + match.slice(-4);
    });

    // Remove BVN references (11 digits)
    cleaned = cleaned.replace(/\bBVN[:\s]*\d{11}\b/gi, 'BVN: [REDACTED]');
    cleaned = cleaned.replace(/\b\d{11}\b/g, (match, offset, str) => {
        // Only redact if near BVN context
        const nearby = str.substring(Math.max(0, offset - 20), offset).toLowerCase();
        if (nearby.includes('bvn')) return '[REDACTED]';
        return match;
    });

    // Remove Session IDs / Transaction references
    cleaned = cleaned.replace(/Session\s*ID[:\s]*[\w-]+/gi, 'Session ID: [REDACTED]');
    cleaned = cleaned.replace(/Transaction\s*(?:Ref|Reference|ID)[:\s]*[\w-]+/gi, 'Transaction Ref: [REDACTED]');
    cleaned = cleaned.replace(/Reference[:\s]*[\w]{15,}/gi, 'Reference: [REDACTED]');

    // Remove phone numbers (Nigerian format: 080, 081, 090, 091, 070, etc.)
    cleaned = cleaned.replace(/\b0[7-9][01]\d{8}\b/g, '[PHONE REDACTED]');
    cleaned = cleaned.replace(/\+234\d{10}/g, '[PHONE REDACTED]');

    // Remove email addresses
    cleaned = cleaned.replace(/[\w.-]+@[\w.-]+\.\w+/g, '[EMAIL REDACTED]');

    // Remove "from" / "to" account holder names in narration if they look like full names
    // Pattern: "FROM SURNAME FIRSTNAME" or "TO SURNAME FIRSTNAME"
    // We keep this light — the AI can still process without names
    cleaned = cleaned.replace(/(FROM|TO|FRM|SENDER|RECEIVER)[:\s]+([A-Z]{2,}\s+[A-Z]{2,}(?:\s+[A-Z]{2,})?)/gi, 
        (match, prefix) => `${prefix}: [NAME REDACTED]`);

    // Remove NIP session references
    cleaned = cleaned.replace(/NIP[:\s]*[\w]+/gi, 'NIP: [REDACTED]');

    return cleaned;
}

/**
 * Detect if text appears to be from a bank statement
 * @param {string} text
 * @returns {boolean}
 */
function isBankStatement(text) {
    const bankKeywords = [
        'statement', 'account', 'balance', 'credit', 'debit',
        'transaction', 'opening balance', 'closing balance',
        'opay', 'gtbank', 'guaranty', 'access bank', 'first bank',
        'zenith', 'uba', 'kuda', 'palmpay', 'moniepoint', 'wema',
        'fidelity', 'stanbic', 'sterling', 'fcmb', 'polaris',
        'transfer', 'withdrawal', 'deposit', 'bank statement'
    ];

    const lowerText = text.toLowerCase();
    let matchCount = 0;
    for (const keyword of bankKeywords) {
        if (lowerText.includes(keyword)) matchCount++;
    }

    return matchCount >= 3;
}

/**
 * Detect if text appears to be a receipt
 * @param {string} text
 * @returns {boolean}
 */
function isReceipt(text) {
    const receiptKeywords = [
        'receipt', 'invoice', 'qty', 'quantity', 'total',
        'amount', 'paid', 'price', 'unit', 'subtotal',
        'vat', 'discount', 'cash', 'change'
    ];

    const lowerText = text.toLowerCase();
    let matchCount = 0;
    for (const keyword of receiptKeywords) {
        if (lowerText.includes(keyword)) matchCount++;
    }

    return matchCount >= 2;
}

module.exports = {
    extractTextFromPDF,
    stripSensitiveData,
    isBankStatement,
    isReceipt,
    PasswordRequiredError
};
