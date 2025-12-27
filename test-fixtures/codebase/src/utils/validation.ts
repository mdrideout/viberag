/**
 * Validation utility functions.
 * Email, password, and form validation helpers.
 */

/**
 * Validate email format.
 */
export function isValidEmail(email: string): boolean {
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	return emailRegex.test(email);
}

/**
 * Validate password strength.
 * Requires: 8+ chars, uppercase, lowercase, number.
 */
export function isStrongPassword(password: string): boolean {
	if (password.length < 8) return false;
	if (!/[A-Z]/.test(password)) return false;
	if (!/[a-z]/.test(password)) return false;
	if (!/[0-9]/.test(password)) return false;
	return true;
}

/**
 * Validate required field.
 */
export function isRequired(value: string): boolean {
	return value.trim().length > 0;
}

/**
 * Validate minimum length.
 */
export function minLength(value: string, min: number): boolean {
	return value.length >= min;
}

/**
 * Validate maximum length.
 */
export function maxLength(value: string, max: number): boolean {
	return value.length <= max;
}
