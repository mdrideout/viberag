/**
 * Utility functions for string formatting and date parsing.
 */

/**
 * Format a string by capitalizing the first letter.
 */
function formatString(str) {
	if (!str) return '';
	return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Parse a date string and return a Date object.
 */
function parseDate(dateString) {
	return new Date(dateString);
}

/**
 * Format a date as a human-readable string.
 */
function formatDate(date) {
	return date.toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	});
}

module.exports = {formatString, parseDate, formatDate};
