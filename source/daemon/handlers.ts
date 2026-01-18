/**
 * Daemon Method Handlers
 *
 * JSON-RPC method implementations for daemon IPC.
 * Each handler receives params and a context with access to owner and server.
 *
 * Simplified for polling-based architecture:
 * - Clients poll status() for state updates
 * - No push notifications or subscriptions
 */

import {z} from 'zod';
import {PROTOCOL_VERSION} from './protocol.js';
import type {Handler, HandlerRegistry} from './server.js';
import {daemonState} from './state.js';
import {isAbortError} from './lib/abort.js';

// ============================================================================
// Parameter Schemas
// ============================================================================

const searchParamsSchema = z.object({
	query: z.string().min(1),
	intent: z
		.enum([
			'auto',
			'definition',
			'usage',
			'concept',
			'exact_text',
			'similar_code',
		])
		.optional(),
	scope: z
		.object({
			path_prefix: z.array(z.string()).optional(),
			path_contains: z.array(z.string()).optional(),
			path_not_contains: z.array(z.string()).optional(),
			extension: z.array(z.string()).optional(),
		})
		.optional(),
	k: z.number().min(1).max(100).optional(),
	explain: z.boolean().optional(),
});

const getSymbolParamsSchema = z.object({
	symbol_id: z.string().min(1),
});

const findUsagesParamsSchema = z
	.object({
		symbol_id: z.string().min(1).optional(),
		symbol_name: z.string().min(1).optional(),
		scope: z
			.object({
				path_prefix: z.array(z.string()).optional(),
				path_contains: z.array(z.string()).optional(),
				path_not_contains: z.array(z.string()).optional(),
				extension: z.array(z.string()).optional(),
			})
			.optional(),
		k: z.number().min(1).max(2000).optional(),
	})
	.refine(v => v.symbol_id || v.symbol_name, {
		message: 'symbol_id or symbol_name is required',
	});

const expandContextParamsSchema = z.object({
	table: z.enum(['symbols', 'chunks', 'files']),
	id: z.string().min(1),
	limit: z.number().min(1).max(200).optional(),
});

const indexParamsSchema = z.object({
	force: z.boolean().optional(),
});

const ACTIVE_INDEX_STATUSES = new Set([
	'initializing',
	'indexing',
	'cancelling',
]);

const shutdownParamsSchema = z.object({
	reason: z.string().optional(),
});

const cancelParamsSchema = z.object({
	target: z.enum(['indexing', 'warmup', 'all']).optional(),
	reason: z.string().optional(),
});

const evalParamsSchema = z
	.object({
		definition_samples: z.number().min(1).max(500).optional(),
		concept_samples: z.number().min(1).max(500).optional(),
		exact_text_samples: z.number().min(1).max(500).optional(),
		similar_code_samples: z.number().min(1).max(500).optional(),
		seed: z.number().int().optional(),
		explain: z.boolean().optional(),
	})
	.optional();

// ============================================================================
// Handlers
// ============================================================================

/**
 * Search handler.
 */
const searchHandler: Handler = async (params, ctx) => {
	const validated = searchParamsSchema.parse(params ?? {});
	const {query, ...options} = validated;

	await ctx.owner.ensureInitialized();
	return ctx.owner.search(query, options);
};

/**
 * Get symbol handler.
 */
const getSymbolHandler: Handler = async (params, ctx) => {
	const validated = getSymbolParamsSchema.parse(params ?? {});
	await ctx.owner.ensureInitialized();
	return ctx.owner.getSymbol(validated.symbol_id);
};

/**
 * Find usages handler.
 */
const findUsagesHandler: Handler = async (params, ctx) => {
	const validated = findUsagesParamsSchema.parse(params ?? {});
	await ctx.owner.ensureInitialized();
	return ctx.owner.findUsages(validated);
};

/**
 * Expand context handler.
 */
const expandContextHandler: Handler = async (params, ctx) => {
	const validated = expandContextParamsSchema.parse(params ?? {});
	await ctx.owner.ensureInitialized();
	return ctx.owner.expandContext(validated);
};

/**
 * Index handler.
 * Simply runs indexing - clients poll status() for progress.
 */
const indexHandler: Handler = async (params, ctx) => {
	const validated = indexParamsSchema.parse(params ?? {});

	await ctx.owner.ensureInitialized();
	// Run indexing - Redux state is updated by indexer directly
	// Clients poll status() to see progress
	const stats = await ctx.owner.index({force: validated.force});
	return stats;
};

/**
 * Index async handler.
 * Starts indexing in the background and returns immediately.
 * Clients poll status() to see progress and completion.
 */
const indexAsyncHandler: Handler = async (params, ctx) => {
	const validated = indexParamsSchema.parse(params ?? {});
	const currentStatus = daemonState.getSnapshot().indexing.status;

	if (ACTIVE_INDEX_STATUSES.has(currentStatus)) {
		return {started: false, reason: 'in_progress'};
	}

	await ctx.owner.ensureInitialized();
	void ctx.owner.index({force: validated.force}).catch(error => {
		if (isAbortError(error)) {
			return;
		}
		console.error('[daemon] Async index failed:', error);
		const logger = ctx.owner.getLogger();
		if (logger) {
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error('DaemonServer', 'Async index failed', err);
		}
	});

	return {started: true};
};

/**
 * Status handler.
 */
const statusHandler: Handler = async (_params, ctx) => {
	return ctx.owner.getStatus();
};

/**
 * Watch status handler.
 */
const watchStatusHandler: Handler = async (_params, ctx) => {
	await ctx.owner.ensureInitialized();
	return ctx.owner.getWatcherStatus();
};

/**
 * Cancel handler.
 * Cancels the current daemon activity without shutting down.
 */
const cancelHandler: Handler = async (params, ctx) => {
	const validated = cancelParamsSchema.parse(params ?? {});
	return ctx.owner.cancelActivity(validated);
};

/**
 * Eval handler.
 */
const evalHandler: Handler = async (params, ctx) => {
	const validated = evalParamsSchema.parse(params ?? {});
	await ctx.owner.ensureInitialized();
	return ctx.owner.eval(validated);
};

/**
 * Shutdown handler.
 * Schedules server stop.
 */
const shutdownHandler: Handler = async (params, ctx) => {
	const validated = shutdownParamsSchema.parse(params ?? {});

	console.error(
		`[daemon] Shutdown requested: ${validated.reason ?? 'no reason'}`,
	);

	// Schedule shutdown after response is sent
	setImmediate(async () => {
		await ctx.owner.shutdown();
		await ctx.server.stop();
		process.exit(0);
	});

	return {success: true};
};

/**
 * Ping handler.
 * Simple health check.
 */
const pingHandler: Handler = async (_params, _ctx) => {
	return {
		pong: true,
		timestamp: Date.now(),
		protocolVersion: PROTOCOL_VERSION,
	};
};

/**
 * Health handler.
 * Returns detailed health information.
 */
const healthHandler: Handler = async (_params, ctx) => {
	const snapshot = daemonState.getSnapshot();

	return {
		healthy: true,
		uptime: process.uptime(),
		memoryUsage: process.memoryUsage(),
		clients: ctx.server.getClientCount(),
		indexStatus: snapshot.indexing.status,
		protocolVersion: PROTOCOL_VERSION,
	};
};

// ============================================================================
// Handler Registry
// ============================================================================

/**
 * Create the handler registry.
 */
export function createHandlers(): HandlerRegistry {
	return {
		search: searchHandler,
		getSymbol: getSymbolHandler,
		findUsages: findUsagesHandler,
		expandContext: expandContextHandler,
		index: indexHandler,
		indexAsync: indexAsyncHandler,
		eval: evalHandler,
		cancel: cancelHandler,
		status: statusHandler,
		watchStatus: watchStatusHandler,
		shutdown: shutdownHandler,
		ping: pingHandler,
		health: healthHandler,
	};
}
