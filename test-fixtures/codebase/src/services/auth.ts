/**
 * Authentication service for user login/logout.
 * Manages authentication state and tokens.
 */
import {post} from './api';

type AuthToken = {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
};

type LoginResponse = {
	user: {id: string; email: string};
	token: AuthToken;
};

let currentToken: AuthToken | null = null;

/**
 * Login with email and password.
 */
export async function login(
	email: string,
	password: string,
): Promise<LoginResponse> {
	const response = await post<LoginResponse>('/auth/login', {email, password});
	currentToken = response.token;
	localStorage.setItem('authToken', JSON.stringify(currentToken));
	return response;
}

/**
 * Logout the current user.
 */
export function logout(): void {
	currentToken = null;
	localStorage.removeItem('authToken');
}

/**
 * Get current authentication token.
 */
export function getToken(): AuthToken | null {
	if (currentToken) return currentToken;

	const stored = localStorage.getItem('authToken');
	if (stored) {
		currentToken = JSON.parse(stored);
		return currentToken;
	}

	return null;
}

/**
 * Check if user is authenticated.
 */
export function isAuthenticated(): boolean {
	const token = getToken();
	if (!token) return false;
	return Date.now() < token.expiresAt;
}
