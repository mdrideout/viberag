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

// ============================================================================
// Parameter Schemas
// ============================================================================

const searchParamsSchema = z.object({
	query: z.string().min(1),
	mode: z
		.enum(['semantic', 'exact', 'hybrid', 'definition', 'similar'])
		.optional(),
	limit: z.number().min(1).max(100).optional(),
	bm25Weight: z.number().min(0).max(1).optional(),
	minScore: z.number().min(0).max(1).optional(),
	filters: z.record(z.string(), z.unknown()).optional(),
	codeSnippet: z.string().optional(),
	symbolName: z.string().optional(),
	autoBoost: z.boolean().optional(),
	autoBoostThreshold: z.number().min(0).max(1).optional(),
	returnDebug: z.boolean().optional(),
});

const indexParamsSchema = z.object({
	force: z.boolean().optional(),
});

const ACTIVE_INDEX_STATUSES = new Set(['initializing', 'indexing']);

const shutdownParamsSchema = z.object({
	reason: z.string().optional(),
});

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
		index: indexHandler,
		indexAsync: indexAsyncHandler,
		status: statusHandler,
		watchStatus: watchStatusHandler,
		shutdown: shutdownHandler,
		ping: pingHandler,
		health: healthHandler,
	};
}
