/**
 * JSON-RPC 2.0 protocol types and helpers for daemon IPC.
 *
 * Protocol: Newline-delimited JSON over Unix socket.
 * Each message is a complete JSON object followed by '\n'.
 */

// ============================================================================
// JSON-RPC 2.0 Types
// ============================================================================

/**
 * JSON-RPC 2.0 request from client to daemon.
 */
export interface JsonRpcRequest {
	jsonrpc: '2.0';
	method: string;
	params?: Record<string, unknown>;
	id: number | string;
}

/**
 * JSON-RPC 2.0 response from daemon to client.
 */
export interface JsonRpcResponse {
	jsonrpc: '2.0';
	result?: unknown;
	error?: JsonRpcError;
	id: number | string | null;
}

/**
 * JSON-RPC 2.0 error object.
 */
export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

// ============================================================================
// Error Codes
// ============================================================================

/**
 * Standard JSON-RPC 2.0 error codes and custom application codes.
 */
export const ErrorCodes = {
	// Standard JSON-RPC 2.0 errors
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,

	// Custom application errors (-32000 to -32099 reserved for implementation)
	NOT_INITIALIZED: -32001,
	INDEX_IN_PROGRESS: -32002,
	SHUTDOWN_IN_PROGRESS: -32003,
	CONNECTION_ERROR: -32004,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// ============================================================================
// Method Types
// ============================================================================

/**
 * Available daemon methods.
 */
export type DaemonMethod =
	| 'search'
	| 'index'
	| 'status'
	| 'watchStatus'
	| 'shutdown'
	| 'ping'
	| 'health';

// ============================================================================
// Protocol Version
// ============================================================================

/**
 * Protocol version for client/daemon compatibility checking.
 * Increment when making breaking changes to the protocol.
 */
export const PROTOCOL_VERSION = 1;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parse a JSON-RPC request from a string.
 * Returns the parsed request or throws an error.
 */
export function parseRequest(line: string): JsonRpcRequest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new JsonRpcParseError('Invalid JSON');
	}

	if (!isValidRequest(parsed)) {
		throw new JsonRpcParseError('Invalid JSON-RPC 2.0 request');
	}

	return parsed;
}

/**
 * Type guard for valid JSON-RPC 2.0 request.
 */
function isValidRequest(obj: unknown): obj is JsonRpcRequest {
	if (typeof obj !== 'object' || obj === null) return false;
	const req = obj as Record<string, unknown>;
	return (
		req['jsonrpc'] === '2.0' &&
		typeof req['method'] === 'string' &&
		(typeof req['id'] === 'number' || typeof req['id'] === 'string') &&
		(req['params'] === undefined || typeof req['params'] === 'object')
	);
}

/**
 * Format a successful JSON-RPC response.
 */
export function formatResponse(
	id: number | string | null,
	result: unknown,
): string {
	const response: JsonRpcResponse = {
		jsonrpc: '2.0',
		result,
		id,
	};
	return JSON.stringify(response) + '\n';
}

/**
 * Format a JSON-RPC error response.
 */
export function formatError(
	id: number | string | null,
	code: ErrorCode,
	message: string,
	data?: unknown,
): string {
	const response: JsonRpcResponse = {
		jsonrpc: '2.0',
		error: {code, message, ...(data !== undefined && {data})},
		id,
	};
	return JSON.stringify(response) + '\n';
}

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Error thrown when parsing JSON-RPC message fails.
 */
export class JsonRpcParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'JsonRpcParseError';
	}
}

/**
 * Error class for JSON-RPC method errors.
 * Use this in handlers to return structured errors.
 */
export class JsonRpcMethodError extends Error {
	readonly code: ErrorCode;
	readonly data?: unknown;

	constructor(code: ErrorCode, message: string, data?: unknown) {
		super(message);
		this.name = 'JsonRpcMethodError';
		this.code = code;
		this.data = data;
	}
}

// ============================================================================
// Message Parsing Utilities
// ============================================================================

/**
 * Buffer for accumulating partial messages.
 * Messages are newline-delimited, so we need to buffer until we see '\n'.
 */
export class MessageBuffer {
	private buffer = '';

	/**
	 * Add data to buffer and extract complete messages.
	 * Returns array of complete message strings.
	 */
	append(data: string): string[] {
		this.buffer += data;
		const messages: string[] = [];

		let newlineIndex: number;
		while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
			const line = this.buffer.slice(0, newlineIndex);
			this.buffer = this.buffer.slice(newlineIndex + 1);

			if (line.trim()) {
				messages.push(line);
			}
		}

		return messages;
	}

	/**
	 * Clear the buffer.
	 */
	clear(): void {
		this.buffer = '';
	}
}
