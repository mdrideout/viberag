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
 * Safely parse JSON response, logging parse failures instead of swallowing them.
 */
async function safeParseJson(
	response: Response,
	provider: string,
): Promise<Record<string, unknown>> {
	try {
		return (await response.json()) as Record<string, unknown>;
	} catch (error) {
		console.warn(
			`[${provider}] Failed to parse error response:`,
			error instanceof Error ? error.message : String(error),
		);
		return {};
	}
}

/**
 * Options for API key validation.
 */
export interface ValidateApiKeyOptions {
	/** OpenAI base URL for regional endpoints (e.g., https://us.api.openai.com/v1) */
	openaiBaseUrl?: string;
}

/**
 * Validate an API key by making a minimal test embedding call.
 *
 * @param provider - The embedding provider type
 * @param apiKey - The API key to validate
 * @param options - Optional configuration (e.g., openaiBaseUrl for regional endpoints)
 * @returns Validation result with error message if invalid
 */
export async function validateApiKey(
	provider: EmbeddingProviderType,
	apiKey: string,
	options?: ValidateApiKeyOptions,
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
				return await validateOpenAIKey(apiKey, options?.openaiBaseUrl);
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
	const response = await fetch(ENDPOINTS.gemini, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-goog-api-key': apiKey,
		},
		body: JSON.stringify({
			content: {parts: [{text: 'test'}]},
		}),
	});

	if (response.ok) {
		return {valid: true};
	}

	const data = await safeParseJson(response, 'gemini');
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

	const data = await safeParseJson(response, 'mistral');
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
 * Supports regional endpoints for corporate accounts with data residency.
 */
async function validateOpenAIKey(
	apiKey: string,
	baseUrl?: string,
): Promise<ValidationResult> {
	const endpoint = baseUrl ? `${baseUrl}/embeddings` : ENDPOINTS.openai;
	const response = await fetch(endpoint, {
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

	const data = await safeParseJson(response, 'openai');
	const error = (data as {error?: {message?: string}})?.error;

	if (response.status === 401) {
		const msg = error?.message ?? '';
		// Check for regional endpoint mismatch
		if (msg.includes('incorrect regional hostname')) {
			const regionMatch = msg.match(
				/make your request to (\w+\.api\.openai\.com)/,
			);
			const requiredEndpoint =
				regionMatch?.[1] ?? 'the correct regional endpoint';
			return {
				valid: false,
				error: `Regional endpoint mismatch. Your account requires ${requiredEndpoint}. Select the matching region (US or EU).`,
			};
		}
		return {valid: false, error: 'Invalid API key'};
	}
	if (error?.message) {
		// Truncate long error messages
		const msg = error.message;
		return {
			valid: false,
			error: msg.length > 100 ? msg.slice(0, 100) + '...' : msg,
		};
	}

	return {valid: false, error: `HTTP ${response.status}`};
}
