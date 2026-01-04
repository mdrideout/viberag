/**
 * API key validation for cloud embedding providers.
 *
 * Makes a minimal test embedding call to verify the API key is valid
 * before proceeding with indexing.
 */

import type {EmbeddingProviderType} from '../../common/types.js';

/**
 * Result of API key validation.
 */
export interface ValidationResult {
	valid: boolean;
	error?: string;
}

/**
 * API endpoints for each cloud provider.
 */
const ENDPOINTS = {
	gemini:
		'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent',
	mistral: 'https://api.mistral.ai/v1/embeddings',
	openai: 'https://api.openai.com/v1/embeddings',
} as const;

/**
 * Validate an API key by making a minimal test embedding call.
 *
 * @param provider - The embedding provider type
 * @param apiKey - The API key to validate
 * @returns Validation result with error message if invalid
 */
export async function validateApiKey(
	provider: EmbeddingProviderType,
	apiKey: string,
): Promise<ValidationResult> {
	// Local providers don't need API key validation
	if (provider === 'local' || provider === 'local-4b') {
		return {valid: true};
	}

	if (!apiKey || apiKey.trim() === '') {
		return {valid: false, error: 'API key is required'};
	}

	try {
		switch (provider) {
			case 'gemini':
				return await validateGeminiKey(apiKey);
			case 'mistral':
				return await validateMistralKey(apiKey);
			case 'openai':
				return await validateOpenAIKey(apiKey);
			default:
				return {valid: false, error: `Unknown provider: ${provider}`};
		}
	} catch (err) {
		return {
			valid: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Validate Gemini API key.
 */
async function validateGeminiKey(apiKey: string): Promise<ValidationResult> {
	const response = await fetch(`${ENDPOINTS.gemini}?key=${apiKey}`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({
			content: {parts: [{text: 'test'}]},
		}),
	});

	if (response.ok) {
		return {valid: true};
	}

	const data = await response.json().catch(() => ({}));
	const message =
		(data as {error?: {message?: string}})?.error?.message ||
		`HTTP ${response.status}`;

	if (response.status === 400 && message.includes('API key')) {
		return {valid: false, error: 'Invalid API key'};
	}
	if (response.status === 403) {
		return {valid: false, error: 'API key not authorized for this API'};
	}

	return {valid: false, error: message};
}

/**
 * Validate Mistral API key.
 */
async function validateMistralKey(apiKey: string): Promise<ValidationResult> {
	const response = await fetch(ENDPOINTS.mistral, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: 'codestral-embed',
			input: ['test'],
		}),
	});

	if (response.ok) {
		return {valid: true};
	}

	const data = await response.json().catch(() => ({}));
	const message =
		(data as {message?: string})?.message ||
		(data as {detail?: string})?.detail ||
		`HTTP ${response.status}`;

	if (response.status === 401) {
		return {valid: false, error: 'Invalid API key'};
	}

	return {valid: false, error: message};
}

/**
 * Validate OpenAI API key.
 */
async function validateOpenAIKey(apiKey: string): Promise<ValidationResult> {
	const response = await fetch(ENDPOINTS.openai, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: 'text-embedding-3-small',
			input: ['test'],
		}),
	});

	if (response.ok) {
		return {valid: true};
	}

	const data = await response.json().catch(() => ({}));
	const error = (data as {error?: {message?: string}})?.error;

	if (response.status === 401) {
		return {valid: false, error: 'Invalid API key'};
	}
	if (error?.message) {
		// Truncate long error messages
		const msg = error.message;
		return {valid: false, error: msg.length > 100 ? msg.slice(0, 100) + '...' : msg};
	}

	return {valid: false, error: `HTTP ${response.status}`};
}
