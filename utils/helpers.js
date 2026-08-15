/**
 * Format a number as Nigerian Naira
 */
function formatNaira(amount) {
    return '₦' + Number(amount).toLocaleString('en-NG');
}

/**
 * Get the current week's start (Monday) and end (Sunday) dates
 * Returns ISO date strings (YYYY-MM-DD)
 */
function getWeekRange() {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ...
    const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;

    const monday = new Date(now);
    monday.setDate(now.getDate() + diffToMonday);
    monday.setHours(0, 0, 0, 0);

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    return {
        weekStart: monday.toISOString().split('T')[0],
        weekEnd: sunday.toISOString().split('T')[0]
    };
}

/**
 * Get the previous week's start and end dates
 */
function getPreviousWeekRange() {
    const { weekStart } = getWeekRange();
    const monday = new Date(weekStart);
    monday.setDate(monday.getDate() - 7);

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    return {
        weekStart: monday.toISOString().split('T')[0],
        weekEnd: sunday.toISOString().split('T')[0]
    };
}

/**
 * Format a date string for display
 */
function formatDate(dateStr) {
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-NG', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Calculate percentage change between two values
 */
function percentChange(current, previous) {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 100);
}

module.exports = {
    formatNaira,
    getWeekRange,
    getPreviousWeekRange,
    formatDate,
    percentChange
};
