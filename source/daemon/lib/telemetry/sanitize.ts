/**
 * Telemetry sanitization.
 *
 * Goal: collect useful inputs/outputs while avoiding file contents / code text.
 * Also applies best-effort redaction of common secrets in freeform strings.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import type {TelemetryMode} from '../user-settings.js';

export type TelemetrySanitizeOptions = {
	mode: TelemetryMode;
	maxDepth?: number;
	maxArrayLength?: number;
	maxStringLength?: number;
};

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_ARRAY_LENGTH = 20;
const DEFAULT_MAX_STRING_LENGTH = 2000;

const FILE_CONTENT_KEYS = new Set([
	'snippet',
	'code_text',
	'codetext',
	'text',
	'lines',
	'content',
	'docstring',
	'signature',
	'decorators',
]);

function normalizeKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z_]/g, '');
}

function isFileContentKey(key: string): boolean {
	return FILE_CONTENT_KEYS.has(normalizeKey(key));
}

function isFilePathKey(key: string): boolean {
	const k = key.toLowerCase();
	return (
		k === 'filepath' ||
		k === 'file_path' ||
		k.endsWith('path') ||
		k.includes('file_path') ||
		k.includes('filepath')
	);
}

function sha256Hex(input: string): string {
	return crypto.createHash('sha256').update(input).digest('hex');
}

export function summarizeText(text: string): {
	sha256: string;
	byte_count: number;
	line_count: number;
} {
	const byte_count = Buffer.byteLength(text, 'utf8');
	const line_count = text ? text.split('\n').length : 0;
	return {
		sha256: sha256Hex(text),
		byte_count,
		line_count,
	};
}

function summarizeString(value: string): {
	sha256: string;
	length: number;
} {
	return {
		sha256: sha256Hex(value),
		length: value.length,
	};
}

function truncateString(value: string, max: number): string {
	if (value.length <= max) return value;
	return value.slice(0, max) + '…(truncated)…';
}

function scrubSensitiveText(value: string): string {
	let v = value;

	// Emails
	v = v.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]');

	// Common API keys / tokens
	v = v.replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED_SECRET]');
	v = v.replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED_SECRET]');
	v = v.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED_SECRET]');
	v = v.replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED_SECRET]');

	// Very long high-entropy-ish chunks (best-effort)
	v = v.replace(/[A-Za-z0-9+/]{80,}={0,2}/g, '[REDACTED_SECRET]');
	v = v.replace(/[a-f0-9]{64,}/gi, '[REDACTED_SECRET]');

	return v;
}

function sanitizeString(
	value: string,
	key: string | null,
	options: Required<TelemetrySanitizeOptions>,
): unknown {
	const keyLower = key?.toLowerCase() ?? '';
	if (key && isFileContentKey(key)) {
		return summarizeText(value);
	}

	if (options.mode === 'stripped') {
		// Never include raw queries/notes in stripped mode.
		if (keyLower === 'query' || keyLower === 'notes') {
			return summarizeString(value);
		}
		// Avoid emitting file paths in stripped mode.
		if (keyLower && isFilePathKey(keyLower)) {
			return {
				...summarizeString(value),
				ext: path.extname(value) || null,
			};
		}

		// Keep short identifiers, hash freeform strings.
		const isFreeform = value.length > 80 || /\s/.test(value);
		return isFreeform ? summarizeString(value) : value;
	}

	// default mode: allow query text with best-effort scrubbing.
	if (keyLower === 'query' || keyLower === 'notes') {
		return truncateString(scrubSensitiveText(value), options.maxStringLength);
	}

	return truncateString(value, Math.min(options.maxStringLength, 5000));
}

function sanitizeNumber(value: number): number | null {
	if (!Number.isFinite(value)) return null;
	return value;
}

function sanitizeArray(
	value: unknown[],
	key: string | null,
	options: Required<TelemetrySanitizeOptions>,
	depth: number,
): unknown {
	const maxArrayLength = options.maxArrayLength;
	const sliced = value.slice(0, maxArrayLength);
	const sanitized = sliced.map(item =>
		sanitizeValue(item, key, options, depth + 1),
	);

	if (value.length <= maxArrayLength) {
		return sanitized;
	}

	return {
		items: sanitized,
		truncated: true,
		original_length: value.length,
		key,
	};
}

function sanitizeObject(
	value: Record<string, unknown>,
	options: Required<TelemetrySanitizeOptions>,
	depth: number,
): unknown {
	if (depth >= options.maxDepth) {
		try {
			return {
				sha256: sha256Hex(JSON.stringify(value)),
				truncated: true,
				max_depth: options.maxDepth,
			};
		} catch {
			return {
				sha256: sha256Hex(String(value)),
				truncated: true,
				max_depth: options.maxDepth,
			};
		}
	}

	const entries = Object.entries(value);
	const maxKeys = 80;
	const sliced = entries.slice(0, maxKeys);

	const out: Record<string, unknown> = {};
	for (const [k, v] of sliced) {
		out[k] = sanitizeValue(v, k, options, depth + 1);
	}

	if (entries.length > maxKeys) {
		out['__truncated_keys'] = {
			truncated: true,
			original_length: entries.length,
			kept: maxKeys,
		};
	}

	return out;
}

function sanitizeValue(
	value: unknown,
	key: string | null,
	options: Required<TelemetrySanitizeOptions>,
	depth: number,
): unknown {
	if (value === null || value === undefined) return null;

	if (key && isFileContentKey(key)) {
		if (typeof value === 'string') return summarizeText(value);
		try {
			return summarizeText(JSON.stringify(value));
		} catch {
			return summarizeText(String(value));
		}
	}

	switch (typeof value) {
		case 'string':
			return sanitizeString(value, key, options);
		case 'number':
			return sanitizeNumber(value);
		case 'boolean':
			return value;
		case 'bigint':
			return value.toString();
		case 'object': {
			if (Array.isArray(value)) {
				return sanitizeArray(value, key, options, depth);
			}
			return sanitizeObject(value as Record<string, unknown>, options, depth);
		}
		default:
			return String(value);
	}
}

export function sanitizeForTelemetry(
	value: unknown,
	options: TelemetrySanitizeOptions,
): unknown {
	const resolved: Required<TelemetrySanitizeOptions> = {
		mode: options.mode,
		maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
		maxArrayLength: options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH,
		maxStringLength: options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
	};

	return sanitizeValue(value, null, resolved, 0);
}
