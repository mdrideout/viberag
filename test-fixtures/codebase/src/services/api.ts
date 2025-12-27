/**
 * API service for making HTTP requests.
 * Centralized API communication layer.
 */

type RequestOptions = {
	method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	headers?: Record<string, string>;
	body?: unknown;
};

const BASE_URL = 'https://api.example.com';

/**
 * Make an API request.
 */
export async function apiRequest<T>(
	endpoint: string,
	options: RequestOptions,
): Promise<T> {
	const url = `${BASE_URL}${endpoint}`;
	const response = await fetch(url, {
		method: options.method,
		headers: {
			'Content-Type': 'application/json',
			...options.headers,
		},
		body: options.body ? JSON.stringify(options.body) : undefined,
	});

	if (!response.ok) {
		throw new Error(`API Error: ${response.status} ${response.statusText}`);
	}

	return response.json();
}

/**
 * GET request helper.
 */
export async function get<T>(endpoint: string): Promise<T> {
	return apiRequest<T>(endpoint, {method: 'GET'});
}

/**
 * POST request helper.
 */
export async function post<T>(endpoint: string, data: unknown): Promise<T> {
	return apiRequest<T>(endpoint, {method: 'POST', body: data});
}
