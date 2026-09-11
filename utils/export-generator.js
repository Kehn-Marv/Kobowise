const ExcelJS = require('exceljs');

// ============ COLOR PALETTE ============
const COLORS = {
    primary: '1B5E20',       // Deep green
    primaryLight: 'E8F5E9',  // Light green bg
    accent: '2E7D32',        // Medium green
    headerBg: '1B5E20',      // Dark green for headers
    headerText: 'FFFFFF',    // White text
    incomeBg: 'E8F5E9',     // Light green for income rows
    expenseBg: 'FFEBEE',    // Light red for expense rows
    profitPositive: '2E7D32',// Green for profit
    profitNegative: 'C62828',// Red for loss
    borderColor: 'BDBDBD',  // Gray borders
    subtotalBg: 'F5F5F5',   // Light gray for subtotals
    white: 'FFFFFF',
    black: '212121',
    gray: '757575',
};

// ============ HELPERS ============
function formatNaira(amount) {
    return '₦' + Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function groupByCategory(transactions, type) {
    const grouped = {};
    transactions
        .filter(t => t.type === type)
        .forEach(t => {
            const cat = t.category || 'Other';
            if (!grouped[cat]) grouped[cat] = { total: 0, count: 0, items: [] };
            grouped[cat].total += Number(t.amount);
            grouped[cat].count++;
            grouped[cat].items.push(t);
        });
    return grouped;
}

function groupByDate(transactions) {
    const grouped = {};
    transactions.forEach(t => {
        const date = t.date || 'Unknown';
        if (!grouped[date]) grouped[date] = { income: 0, expense: 0, items: [] };
        if (t.type === 'income') grouped[date].income += Number(t.amount);
        else grouped[date].expense += Number(t.amount);
        grouped[date].items.push(t);
    });
    return grouped;
}

function getDateRange(transactions) {
    if (!transactions.length) return { start: 'N/A', end: 'N/A' };
    const dates = transactions.map(t => t.date).filter(Boolean).sort();
    return { start: dates[0], end: dates[dates.length - 1] };
}

function formatDateNigerian(dateStr) {
    if (!dateStr || dateStr === 'N/A') return 'N/A';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ============ PROFESSIONAL PDF EXPORT ============
async function generateProfessionalPDF(user, transactions, options = {}) {
    const PDFDocument = require('pdfkit-table');
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));

    const totalIncome = transactions.filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amount), 0);
    const totalExpense = transactions.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0);
    const profit = totalIncome - totalExpense;
    const margin = totalIncome > 0 ? ((profit / totalIncome) * 100).toFixed(1) : '0.0';
    const dateRange = getDateRange(transactions);

    // ---- HEADER ----
    doc.rect(0, 0, doc.page.width, 100).fill('#1B5E20');
    doc.fill('#FFFFFF').fontSize(22).text(user.business_name.toUpperCase(), 40, 25, { align: 'left' });
    doc.fontSize(10).text(`Business Type: ${user.business_type || 'General'}`, 40, 52);
    doc.text(`Location: ${user.location || 'Nigeria'}`, 40, 66);
    doc.text(`Report Period: ${formatDateNigerian(dateRange.start)} — ${formatDateNigerian(dateRange.end)}`, 40, 80);
    doc.text(`Generated: ${formatDateNigerian(new Date().toISOString().split('T')[0])}`, doc.page.width - 240, 80);
    doc.fill('#212121');

    // ---- SUMMARY CARDS ----
    doc.moveDown(3);
    const cardY = 120;
    const cardWidth = (doc.page.width - 120) / 4;

    const cards = [
        { label: 'TOTAL REVENUE', value: formatNaira(totalIncome), color: '#2E7D32' },
        { label: 'TOTAL EXPENSES', value: formatNaira(totalExpense), color: '#C62828' },
        { label: 'NET PROFIT', value: formatNaira(profit), color: profit >= 0 ? '#2E7D32' : '#C62828' },
        { label: 'PROFIT MARGIN', value: `${margin}%`, color: profit >= 0 ? '#2E7D32' : '#C62828' },
    ];

    cards.forEach((card, i) => {
        const x = 40 + i * (cardWidth + 10);
        doc.rect(x, cardY, cardWidth, 55).lineWidth(0.5).stroke('#BDBDBD');
        doc.fill('#757575').fontSize(7).text(card.label, x + 8, cardY + 8, { width: cardWidth - 16 });
        doc.fill(card.color).fontSize(12).text(card.value, x + 8, cardY + 25, { width: cardWidth - 16 });
    });

    doc.fill('#212121');

    // ---- TRANSACTION TABLE ----
    doc.moveDown(5);
    doc.y = 200;

    const tableArray = {
        headers: [
            { label: 'Date', width: 75, headerColor: '#1B5E20', headerOpacity: 1 },
            { label: 'Type', width: 55, headerColor: '#1B5E20', headerOpacity: 1 },
            { label: 'Category', width: 95, headerColor: '#1B5E20', headerOpacity: 1 },
            { label: 'Description', width: 160, headerColor: '#1B5E20', headerOpacity: 1 },
            { label: 'Amount (₦)', width: 85, headerColor: '#1B5E20', headerOpacity: 1, renderer: null },
            { label: 'Method', width: 55, headerColor: '#1B5E20', headerOpacity: 1 },
        ],
        rows: transactions.map(t => [
            t.date || '',
            t.type === 'income' ? '💰 Income' : '💸 Expense',
            t.category || '',
            t.description || '',
            Number(t.amount).toLocaleString('en-NG', { minimumFractionDigits: 2 }),
            (t.payment_method || 'unknown').charAt(0).toUpperCase() + (t.payment_method || 'unknown').slice(1),
        ])
    };

    // Add summary rows
    tableArray.rows.push(['', '', '', '', '', '']);
    tableArray.rows.push(['', '', '', 'TOTAL REVENUE', Number(totalIncome).toLocaleString('en-NG', { minimumFractionDigits: 2 }), '']);
    tableArray.rows.push(['', '', '', 'TOTAL EXPENSES', Number(totalExpense).toLocaleString('en-NG', { minimumFractionDigits: 2 }), '']);
    tableArray.rows.push(['', '', '', 'NET PROFIT/LOSS', Number(profit).toLocaleString('en-NG', { minimumFractionDigits: 2 }), '']);
    tableArray.rows.push(['', '', '', 'PROFIT MARGIN', `${margin}%`, '']);

    await doc.table(tableArray, {
        width: 525,
        prepareHeader: () => doc.font('Helvetica-Bold').fontSize(8).fill('#FFFFFF'),
        prepareRow: (row, indexColumn, indexRow) => {
            doc.font('Helvetica').fontSize(7.5).fill('#212121');
        }
    });

    // ---- FOOTER ----
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
        doc.switchToPage(i);
        doc.fill('#757575').fontSize(7)
            .text('Generated by Kobowise — AI Business Doctor for Nigerian SMEs | kobowise.onrender.com', 40, doc.page.height - 30, { align: 'center', width: doc.page.width - 80 });
    }

    return new Promise((resolve) => {
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.end();
    });
}

// ============ INCOME STATEMENT PDF ============
async function generateIncomeStatementPDF(user, transactions, options = {}) {
    const PDFDocument = require('pdfkit-table');
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));

    const totalIncome = transactions.filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amount), 0);
    const totalExpense = transactions.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0);
    const profit = totalIncome - totalExpense;
    const margin = totalIncome > 0 ? ((profit / totalIncome) * 100).toFixed(1) : '0.0';
    const dateRange = getDateRange(transactions);
    const incomeByCategory = groupByCategory(transactions, 'income');
    const expenseByCategory = groupByCategory(transactions, 'expense');

    // ---- HEADER ----
    doc.rect(0, 0, doc.page.width, 90).fill('#1B5E20');
    doc.fill('#FFFFFF').fontSize(20).text('INCOME STATEMENT', 40, 20, { align: 'center' });
    doc.fontSize(14).text(user.business_name.toUpperCase(), 40, 45, { align: 'center' });
    doc.fontSize(9).text(`Period: ${formatDateNigerian(dateRange.start)} — ${formatDateNigerian(dateRange.end)}`, 40, 68, { align: 'center' });
    doc.fill('#212121');

    // ---- REVENUE SECTION ----
    doc.moveDown(3);
    let y = 110;

    doc.fill('#1B5E20').fontSize(13).text('REVENUE', 40, y);
    doc.moveTo(40, y + 18).lineTo(555, y + 18).lineWidth(1).stroke('#1B5E20');
    y += 28;

    const incomeCategories = Object.entries(incomeByCategory).sort((a, b) => b[1].total - a[1].total);
    for (const [cat, data] of incomeCategories) {
        doc.fill('#212121').fontSize(10).text(cat, 60, y);
        doc.text(formatNaira(data.total), 400, y, { width: 155, align: 'right' });
        y += 18;
    }

    if (incomeCategories.length === 0) {
        doc.fill('#757575').fontSize(10).text('No revenue recorded in this period', 60, y);
        y += 18;
    }

    // Total Revenue line
    doc.moveTo(350, y).lineTo(555, y).lineWidth(0.5).stroke('#212121');
    y += 5;
    doc.fill('#1B5E20').fontSize(11).text('Total Revenue', 60, y);
    doc.text(formatNaira(totalIncome), 400, y, { width: 155, align: 'right' });
    y += 30;

    // ---- EXPENSES SECTION ----
    doc.fill('#C62828').fontSize(13).text('EXPENSES', 40, y);
    doc.moveTo(40, y + 18).lineTo(555, y + 18).lineWidth(1).stroke('#C62828');
    y += 28;

    const expenseCategories = Object.entries(expenseByCategory).sort((a, b) => b[1].total - a[1].total);
    for (const [cat, data] of expenseCategories) {
        doc.fill('#212121').fontSize(10).text(cat, 60, y);
        doc.text(`(${formatNaira(data.total)})`, 400, y, { width: 155, align: 'right' });
        y += 18;
    }

    if (expenseCategories.length === 0) {
        doc.fill('#757575').fontSize(10).text('No expenses recorded in this period', 60, y);
        y += 18;
    }

    // Total Expenses line
    doc.moveTo(350, y).lineTo(555, y).lineWidth(0.5).stroke('#212121');
    y += 5;
    doc.fill('#C62828').fontSize(11).text('Total Expenses', 60, y);
    doc.text(`(${formatNaira(totalExpense)})`, 400, y, { width: 155, align: 'right' });
    y += 35;

    // ---- NET PROFIT/LOSS ----
    doc.moveTo(40, y).lineTo(555, y).lineWidth(2).stroke('#212121');
    y += 8;
    const profitColor = profit >= 0 ? '#2E7D32' : '#C62828';
    doc.fill(profitColor).fontSize(14).text(profit >= 0 ? 'NET PROFIT' : 'NET LOSS', 40, y);
    doc.text(formatNaira(Math.abs(profit)), 400, y, { width: 155, align: 'right' });
    y += 22;
    doc.fill('#757575').fontSize(10).text(`Profit Margin: ${margin}%`, 40, y);
    doc.moveTo(40, y + 15).lineTo(555, y + 15).lineWidth(2).stroke('#212121');

    // ---- FOOTER ----
    doc.fill('#757575').fontSize(7)
        .text('Generated by Kobowise — AI Business Doctor for Nigerian SMEs | This is a management account for internal use', 40, doc.page.height - 30, { align: 'center', width: doc.page.width - 80 });

    return new Promise((resolve) => {
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.end();
    });
}

// ============ EXCEL WORKBOOK GENERATOR ============
async function generateExcelWorkbook(user, transactions, options = {}) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Kobowise';
    workbook.created = new Date();

    const totalIncome = transactions.filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amount), 0);
    const totalExpense = transactions.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0);
    const profit = totalIncome - totalExpense;
    const margin = totalIncome > 0 ? ((profit / totalIncome) * 100).toFixed(1) : '0.0';
    const dateRange = getDateRange(transactions);
    const incomeByCategory = groupByCategory(transactions, 'income');
    const expenseByCategory = groupByCategory(transactions, 'expense');
    const byDate = groupByDate(transactions);

    // ============ SHEET 1: TRANSACTIONS ============
    const txSheet = workbook.addWorksheet('Transactions', {
        properties: { tabColor: { argb: '1B5E20' } }
    });

    // Title row
    txSheet.mergeCells('A1:G1');
    const titleCell = txSheet.getCell('A1');
    titleCell.value = `${user.business_name} — Transaction Record`;
    titleCell.font = { bold: true, size: 14, color: { argb: 'FFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1B5E20' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    txSheet.getRow(1).height = 30;

    // Subtitle
    txSheet.mergeCells('A2:G2');
    const subtitleCell = txSheet.getCell('A2');
    subtitleCell.value = `Period: ${formatDateNigerian(dateRange.start)} — ${formatDateNigerian(dateRange.end)} | Generated: ${formatDateNigerian(new Date().toISOString().split('T')[0])}`;
    subtitleCell.font = { size: 9, italic: true, color: { argb: '757575' } };
    subtitleCell.alignment = { horizontal: 'center' };

    // Headers
    const headers = ['Date', 'Type', 'Category', 'Description', 'Amount (₦)', 'Payment Method', 'Source'];
    const headerRow = txSheet.addRow(headers);
    headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFF' }, size: 10 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '2E7D32' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
            bottom: { style: 'medium', color: { argb: '1B5E20' } }
        };
    });
    txSheet.getRow(3).height = 22;

    // Data rows
    transactions.forEach((t, idx) => {
        const row = txSheet.addRow([
            t.date || '',
            t.type === 'income' ? 'Income' : 'Expense',
            t.category || '',
            t.description || '',
            Number(t.amount),
            (t.payment_method || 'unknown').charAt(0).toUpperCase() + (t.payment_method || 'unknown').slice(1),
            (t.source || 'text').charAt(0).toUpperCase() + (t.source || 'text').slice(1),
        ]);

        // Alternate row colors
        const bgColor = t.type === 'income' ? 'E8F5E9' : 'FFEBEE';
        row.eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
            cell.border = {
                bottom: { style: 'thin', color: { argb: 'BDBDBD' } }
            };
            cell.font = { size: 9 };
        });

        // Currency format for amount
        row.getCell(5).numFmt = '#,##0.00';
        row.getCell(5).alignment = { horizontal: 'right' };
    });

    // Summary rows at bottom
    const emptyRow = txSheet.addRow([]);
    const summaryStartRow = txSheet.lastRow.number + 1;

    const revenueRow = txSheet.addRow(['', '', '', 'TOTAL REVENUE', totalIncome, '', '']);
    revenueRow.getCell(4).font = { bold: true, size: 10 };
    revenueRow.getCell(5).font = { bold: true, size: 10, color: { argb: '2E7D32' } };
    revenueRow.getCell(5).numFmt = '#,##0.00';

    const expenseRow = txSheet.addRow(['', '', '', 'TOTAL EXPENSES', totalExpense, '', '']);
    expenseRow.getCell(4).font = { bold: true, size: 10 };
    expenseRow.getCell(5).font = { bold: true, size: 10, color: { argb: 'C62828' } };
    expenseRow.getCell(5).numFmt = '#,##0.00';

    const profitRow = txSheet.addRow(['', '', '', 'NET PROFIT/LOSS', profit, '', '']);
    profitRow.getCell(4).font = { bold: true, size: 11 };
    profitRow.getCell(5).font = { bold: true, size: 11, color: { argb: profit >= 0 ? '2E7D32' : 'C62828' } };
    profitRow.getCell(5).numFmt = '#,##0.00';
    profitRow.getCell(5).border = { top: { style: 'double', color: { argb: '212121' } }, bottom: { style: 'double', color: { argb: '212121' } } };

    const marginRow = txSheet.addRow(['', '', '', 'PROFIT MARGIN', `${margin}%`, '', '']);
    marginRow.getCell(4).font = { bold: true, size: 10 };
    marginRow.getCell(5).font = { bold: true, size: 10 };

    // Column widths
    txSheet.getColumn(1).width = 14;
    txSheet.getColumn(2).width = 10;
    txSheet.getColumn(3).width = 20;
    txSheet.getColumn(4).width = 35;
    txSheet.getColumn(5).width = 16;
    txSheet.getColumn(6).width = 16;
    txSheet.getColumn(7).width = 10;

    // ============ SHEET 2: INCOME STATEMENT ============
    const isSheet = workbook.addWorksheet('Income Statement', {
        properties: { tabColor: { argb: '2E7D32' } }
    });

    isSheet.mergeCells('A1:C1');
    const isTitle = isSheet.getCell('A1');
    isTitle.value = 'INCOME STATEMENT';
    isTitle.font = { bold: true, size: 16, color: { argb: 'FFFFFF' } };
    isTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1B5E20' } };
    isTitle.alignment = { horizontal: 'center', vertical: 'middle' };
    isSheet.getRow(1).height = 32;

    isSheet.mergeCells('A2:C2');
    isSheet.getCell('A2').value = user.business_name.toUpperCase();
    isSheet.getCell('A2').font = { bold: true, size: 12 };
    isSheet.getCell('A2').alignment = { horizontal: 'center' };

    isSheet.mergeCells('A3:C3');
    isSheet.getCell('A3').value = `Period: ${formatDateNigerian(dateRange.start)} — ${formatDateNigerian(dateRange.end)}`;
    isSheet.getCell('A3').font = { italic: true, size: 9, color: { argb: '757575' } };
    isSheet.getCell('A3').alignment = { horizontal: 'center' };

    let isRow = 5;

    // Revenue section
    const revHeader = isSheet.getRow(isRow);
    revHeader.getCell(1).value = 'REVENUE';
    revHeader.getCell(1).font = { bold: true, size: 12, color: { argb: '1B5E20' } };
    revHeader.getCell(3).value = 'Amount (₦)';
    revHeader.getCell(3).font = { bold: true, size: 10, color: { argb: '757575' } };
    revHeader.getCell(3).alignment = { horizontal: 'right' };
    isRow++;

    const sortedIncome = Object.entries(incomeByCategory).sort((a, b) => b[1].total - a[1].total);
    for (const [cat, data] of sortedIncome) {
        const row = isSheet.getRow(isRow);
        row.getCell(1).value = `   ${cat}`;
        row.getCell(2).value = `${data.count} transaction${data.count > 1 ? 's' : ''}`;
        row.getCell(2).font = { size: 8, color: { argb: '757575' } };
        row.getCell(3).value = data.total;
        row.getCell(3).numFmt = '#,##0.00';
        row.getCell(3).alignment = { horizontal: 'right' };
        isRow++;
    }

    // Total Revenue
    isRow++;
    const totalRevRow = isSheet.getRow(isRow);
    totalRevRow.getCell(1).value = 'Total Revenue';
    totalRevRow.getCell(1).font = { bold: true, size: 11 };
    totalRevRow.getCell(3).value = totalIncome;
    totalRevRow.getCell(3).numFmt = '#,##0.00';
    totalRevRow.getCell(3).font = { bold: true, size: 11, color: { argb: '2E7D32' } };
    totalRevRow.getCell(3).alignment = { horizontal: 'right' };
    totalRevRow.getCell(3).border = { top: { style: 'thin' }, bottom: { style: 'thin' } };
    isRow += 2;

    // Expenses section
    const expHeader = isSheet.getRow(isRow);
    expHeader.getCell(1).value = 'EXPENSES';
    expHeader.getCell(1).font = { bold: true, size: 12, color: { argb: 'C62828' } };
    isRow++;

    const sortedExpenses = Object.entries(expenseByCategory).sort((a, b) => b[1].total - a[1].total);
    for (const [cat, data] of sortedExpenses) {
        const row = isSheet.getRow(isRow);
        row.getCell(1).value = `   ${cat}`;
        row.getCell(2).value = `${data.count} transaction${data.count > 1 ? 's' : ''}`;
        row.getCell(2).font = { size: 8, color: { argb: '757575' } };
        row.getCell(3).value = data.total;
        row.getCell(3).numFmt = '#,##0.00';
        row.getCell(3).alignment = { horizontal: 'right' };
        row.getCell(3).font = { color: { argb: 'C62828' } };
        isRow++;
    }

    // Total Expenses
    isRow++;
    const totalExpRow = isSheet.getRow(isRow);
    totalExpRow.getCell(1).value = 'Total Expenses';
    totalExpRow.getCell(1).font = { bold: true, size: 11 };
    totalExpRow.getCell(3).value = totalExpense;
    totalExpRow.getCell(3).numFmt = '#,##0.00';
    totalExpRow.getCell(3).font = { bold: true, size: 11, color: { argb: 'C62828' } };
    totalExpRow.getCell(3).alignment = { horizontal: 'right' };
    totalExpRow.getCell(3).border = { top: { style: 'thin' }, bottom: { style: 'thin' } };
    isRow += 2;

    // Net Profit
    const netRow = isSheet.getRow(isRow);
    netRow.getCell(1).value = profit >= 0 ? 'NET PROFIT' : 'NET LOSS';
    netRow.getCell(1).font = { bold: true, size: 13 };
    netRow.getCell(3).value = profit;
    netRow.getCell(3).numFmt = '#,##0.00';
    netRow.getCell(3).font = { bold: true, size: 13, color: { argb: profit >= 0 ? '2E7D32' : 'C62828' } };
    netRow.getCell(3).alignment = { horizontal: 'right' };
    netRow.getCell(3).border = { top: { style: 'double' }, bottom: { style: 'double' } };
    isRow++;

    const marginCellRow = isSheet.getRow(isRow);
    marginCellRow.getCell(1).value = 'Profit Margin';
    marginCellRow.getCell(1).font = { size: 10, color: { argb: '757575' } };
    marginCellRow.getCell(3).value = `${margin}%`;
    marginCellRow.getCell(3).font = { bold: true, size: 10 };
    marginCellRow.getCell(3).alignment = { horizontal: 'right' };

    isSheet.getColumn(1).width = 30;
    isSheet.getColumn(2).width = 18;
    isSheet.getColumn(3).width = 20;

    // ============ SHEET 3: CASH FLOW ============
    const cfSheet = workbook.addWorksheet('Cash Flow', {
        properties: { tabColor: { argb: '0D47A1' } }
    });

    cfSheet.mergeCells('A1:E1');
    const cfTitle = cfSheet.getCell('A1');
    cfTitle.value = 'CASH FLOW STATEMENT';
    cfTitle.font = { bold: true, size: 16, color: { argb: 'FFFFFF' } };
    cfTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '0D47A1' } };
    cfTitle.alignment = { horizontal: 'center', vertical: 'middle' };
    cfSheet.getRow(1).height = 32;

    cfSheet.mergeCells('A2:E2');
    cfSheet.getCell('A2').value = `${user.business_name} | Period: ${formatDateNigerian(dateRange.start)} — ${formatDateNigerian(dateRange.end)}`;
    cfSheet.getCell('A2').font = { italic: true, size: 9, color: { argb: '757575' } };
    cfSheet.getCell('A2').alignment = { horizontal: 'center' };

    // Headers
    const cfHeaders = cfSheet.addRow(['Date', 'Cash Inflow (₦)', 'Cash Outflow (₦)', 'Net Flow (₦)', 'Running Balance (₦)']);
    cfHeaders.eachCell((cell) => {
        cell.font = { bold: true, size: 10, color: { argb: 'FFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1565C0' } };
        cell.alignment = { horizontal: 'center' };
    });

    // Daily cash flow rows
    const sortedDates = Object.keys(byDate).sort();
    let runningBalance = 0;

    for (const date of sortedDates) {
        const dayData = byDate[date];
        const netFlow = dayData.income - dayData.expense;
        runningBalance += netFlow;

        const row = cfSheet.addRow([
            date,
            dayData.income,
            dayData.expense,
            netFlow,
            runningBalance
        ]);

        row.getCell(2).numFmt = '#,##0.00';
        row.getCell(2).font = { color: { argb: '2E7D32' } };
        row.getCell(3).numFmt = '#,##0.00';
        row.getCell(3).font = { color: { argb: 'C62828' } };
        row.getCell(4).numFmt = '#,##0.00';
        row.getCell(4).font = { color: { argb: netFlow >= 0 ? '2E7D32' : 'C62828' } };
        row.getCell(5).numFmt = '#,##0.00';
        row.getCell(5).font = { bold: true, color: { argb: runningBalance >= 0 ? '2E7D32' : 'C62828' } };

        row.eachCell(cell => {
            cell.border = { bottom: { style: 'thin', color: { argb: 'E0E0E0' } } };
        });
    }

    // Totals
    cfSheet.addRow([]);
    const cfTotalRow = cfSheet.addRow(['TOTALS', totalIncome, totalExpense, profit, runningBalance]);
    cfTotalRow.eachCell(cell => {
        cell.font = { bold: true, size: 11 };
        cell.border = { top: { style: 'double' }, bottom: { style: 'double' } };
    });
    cfTotalRow.getCell(2).numFmt = '#,##0.00';
    cfTotalRow.getCell(3).numFmt = '#,##0.00';
    cfTotalRow.getCell(4).numFmt = '#,##0.00';
    cfTotalRow.getCell(5).numFmt = '#,##0.00';

    cfSheet.getColumn(1).width = 14;
    cfSheet.getColumn(2).width = 18;
    cfSheet.getColumn(3).width = 18;
    cfSheet.getColumn(4).width = 16;
    cfSheet.getColumn(5).width = 20;

    // ============ SHEET 4: SUMMARY DASHBOARD ============
    const dashSheet = workbook.addWorksheet('Summary', {
        properties: { tabColor: { argb: 'FF6F00' } }
    });

    dashSheet.mergeCells('A1:D1');
    const dashTitle = dashSheet.getCell('A1');
    dashTitle.value = 'BUSINESS SUMMARY DASHBOARD';
    dashTitle.font = { bold: true, size: 16, color: { argb: 'FFFFFF' } };
    dashTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E65100' } };
    dashTitle.alignment = { horizontal: 'center', vertical: 'middle' };
    dashSheet.getRow(1).height = 32;

    dashSheet.mergeCells('A2:D2');
    dashSheet.getCell('A2').value = `${user.business_name} | ${user.business_type || 'General'} | ${user.location || 'Nigeria'}`;
    dashSheet.getCell('A2').font = { italic: true, size: 9, color: { argb: '757575' } };
    dashSheet.getCell('A2').alignment = { horizontal: 'center' };

    let dRow = 4;

    // Key Metrics
    const metricsTitle = dashSheet.getRow(dRow);
    metricsTitle.getCell(1).value = 'KEY METRICS';
    metricsTitle.getCell(1).font = { bold: true, size: 12, color: { argb: 'E65100' } };
    dRow++;

    const metrics = [
        ['Total Revenue', formatNaira(totalIncome)],
        ['Total Expenses', formatNaira(totalExpense)],
        ['Net Profit/Loss', formatNaira(profit)],
        ['Profit Margin', `${margin}%`],
        ['Total Transactions', String(transactions.length)],
        ['Income Transactions', String(transactions.filter(t => t.type === 'income').length)],
        ['Expense Transactions', String(transactions.filter(t => t.type === 'expense').length)],
        ['Report Period', `${formatDateNigerian(dateRange.start)} — ${formatDateNigerian(dateRange.end)}`],
        ['Days Active', String(Object.keys(byDate).length)],
        ['Avg Daily Revenue', formatNaira(Object.keys(byDate).length > 0 ? totalIncome / Object.keys(byDate).length : 0)],
        ['Avg Daily Expenses', formatNaira(Object.keys(byDate).length > 0 ? totalExpense / Object.keys(byDate).length : 0)],
    ];

    for (const [label, value] of metrics) {
        const row = dashSheet.getRow(dRow);
        row.getCell(1).value = label;
        row.getCell(1).font = { size: 10, color: { argb: '757575' } };
        row.getCell(2).value = value;
        row.getCell(2).font = { bold: true, size: 10 };
        dRow++;
    }

    dRow += 2;

    // Top Revenue Sources
    const topRevTitle = dashSheet.getRow(dRow);
    topRevTitle.getCell(1).value = 'TOP REVENUE SOURCES';
    topRevTitle.getCell(1).font = { bold: true, size: 12, color: { argb: '2E7D32' } };
    dRow++;

    const topIncome = Object.entries(incomeByCategory).sort((a, b) => b[1].total - a[1].total).slice(0, 5);
    for (const [cat, data] of topIncome) {
        const row = dashSheet.getRow(dRow);
        row.getCell(1).value = cat;
        row.getCell(2).value = formatNaira(data.total);
        row.getCell(3).value = `${data.count} transactions`;
        row.getCell(4).value = totalIncome > 0 ? `${((data.total / totalIncome) * 100).toFixed(1)}%` : '0%';
        row.getCell(4).font = { bold: true };
        dRow++;
    }

    dRow += 2;

    // Top Expense Drivers
    const topExpTitle = dashSheet.getRow(dRow);
    topExpTitle.getCell(1).value = 'TOP EXPENSE DRIVERS';
    topExpTitle.getCell(1).font = { bold: true, size: 12, color: { argb: 'C62828' } };
    dRow++;

    const topExpenses = Object.entries(expenseByCategory).sort((a, b) => b[1].total - a[1].total).slice(0, 5);
    for (const [cat, data] of topExpenses) {
        const row = dashSheet.getRow(dRow);
        row.getCell(1).value = cat;
        row.getCell(2).value = formatNaira(data.total);
        row.getCell(3).value = `${data.count} transactions`;
        row.getCell(4).value = totalExpense > 0 ? `${((data.total / totalExpense) * 100).toFixed(1)}%` : '0%';
        row.getCell(4).font = { bold: true };
        dRow++;
    }

    // Payment method breakdown
    dRow += 2;
    const pmTitle = dashSheet.getRow(dRow);
    pmTitle.getCell(1).value = 'PAYMENT METHODS';
    pmTitle.getCell(1).font = { bold: true, size: 12, color: { argb: '0D47A1' } };
    dRow++;

    const pmBreakdown = {};
    transactions.forEach(t => {
        const method = (t.payment_method || 'unknown').toLowerCase();
        if (!pmBreakdown[method]) pmBreakdown[method] = { count: 0, total: 0 };
        pmBreakdown[method].count++;
        pmBreakdown[method].total += Number(t.amount);
    });

    for (const [method, data] of Object.entries(pmBreakdown).sort((a, b) => b[1].total - a[1].total)) {
        const row = dashSheet.getRow(dRow);
        row.getCell(1).value = method.charAt(0).toUpperCase() + method.slice(1);
        row.getCell(2).value = formatNaira(data.total);
        row.getCell(3).value = `${data.count} transactions`;
        dRow++;
    }

    dashSheet.getColumn(1).width = 25;
    dashSheet.getColumn(2).width = 20;
    dashSheet.getColumn(3).width = 18;
    dashSheet.getColumn(4).width = 12;

    // Generate buffer
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
}

module.exports = {
    generateProfessionalPDF,
    generateIncomeStatementPDF,
    generateExcelWorkbook,
};
