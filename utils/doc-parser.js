const mammoth = require('mammoth');

/**
 * Extract text from various document formats (.docx, .txt, .csv)
 * @param {Buffer} buffer - The file buffer
 * @param {string} mimeType - The mime type or file extension
 * @returns {Promise<string>} - Extracted text content
 */
async function extractTextFromDoc(buffer, mimeType) {
    try {
        const type = mimeType.toLowerCase();
        
        // Handle DOCX
        if (type.includes('wordprocessingml.document') || type.endsWith('.docx')) {
            const result = await mammoth.extractRawText({ buffer: buffer });
            return result.value || '';
        }
        
        // Handle TXT, CSV (plain text formats)
        if (type.includes('text/plain') || type.includes('text/csv') || type.endsWith('.txt') || type.endsWith('.csv')) {
            return buffer.toString('utf8');
        }

        throw new Error('Unsupported document format');
    } catch (err) {
        console.error('[Doc Parser] Failed to extract text:', err.message);
        throw new Error('Could not read this document file. It may be corrupted or in an unsupported format.');
    }
}

/**
 * Check if the mime type is supported by the doc parser
 */
function isSupportedDocFormat(mimeType, fileName = '') {
    const type = mimeType.toLowerCase();
    const name = fileName.toLowerCase();
    
    return type.includes('wordprocessingml.document') || 
           type.includes('text/plain') || 
           type.includes('text/csv') ||
           name.endsWith('.docx') ||
           name.endsWith('.txt') ||
           name.endsWith('.csv');
}

module.exports = {
    extractTextFromDoc,
    isSupportedDocFormat
};
