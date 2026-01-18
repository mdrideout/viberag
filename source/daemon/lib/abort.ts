/**
 * Abort utilities for cooperative cancellation.
 */

type AbortSignalWithReason = AbortSignal & {reason?: unknown};

function normalizeReason(reason: unknown): string {
	if (reason instanceof Error) {
		return reason.message || 'Cancelled';
	}
	if (typeof reason === 'string' && reason.trim().length > 0) {
		return reason;
	}
	if (reason === undefined || reason === null) {
		return 'Cancelled';
	}
	return String(reason);
}

export function getAbortReason(signal?: AbortSignal): string {
	const reason = (signal as AbortSignalWithReason | undefined)?.reason;
	return normalizeReason(reason);
}

export function createAbortError(reason?: unknown): Error {
	const error = new Error(normalizeReason(reason));
	error.name = 'AbortError';
	return error;
}

export function throwIfAborted(signal?: AbortSignal, context?: string): void {
	if (!signal?.aborted) {
		return;
	}
	const reason = getAbortReason(signal);
	const message = context ? `${context}: ${reason}` : reason;
	throw createAbortError(message);
}

export function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const err = error as Error & {code?: string};
	return (
		err.name === 'AbortError' ||
		err.name === 'IndexingCancelledError' ||
		err.code === 'ABORT_ERR' ||
		err.code === 'ERR_ABORTED'
	);
}
