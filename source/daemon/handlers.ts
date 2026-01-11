/**
 * Daemon Method Handlers
 *
 * JSON-RPC method implementations for daemon IPC.
 * Each handler receives params and a context with access to owner and server.
 */

import {z} from 'zod';
import {ErrorCodes, JsonRpcMethodError, PROTOCOL_VERSION} from './protocol.js';
import type {Handler, HandlerRegistry} from './server.js';
import {store, selectIndexingState, selectSlots} from '../store/index.js';
import type {SlotState} from '../store/index.js';

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

const shutdownParamsSchema = z.object({
	reason: z.string().optional(),
});

const subscribeParamsSchema = z.object({
	protocolVersion: z.number().optional(),
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

	return ctx.owner.search(query, options);
};

/**
 * Index handler.
 * Subscribes client to progress notifications during indexing.
 */
const indexHandler: Handler = async (params, ctx) => {
	const validated = indexParamsSchema.parse(params ?? {});

	// Subscribe client to receive progress updates
	ctx.server.subscribeClient(ctx.clientId);

	// Track last states for change detection
	let lastIndexingState = selectIndexingState(store.getState());
	let lastSlots = selectSlots(store.getState());

	// Set up Redux listener to broadcast progress and slot updates
	const unsubscribe = store.subscribe(() => {
		const currentIndexingState = selectIndexingState(store.getState());
		const currentSlots = selectSlots(store.getState());

		// Broadcast indexing progress if changed
		if (
			currentIndexingState.status !== lastIndexingState.status ||
			currentIndexingState.current !== lastIndexingState.current ||
			currentIndexingState.total !== lastIndexingState.total ||
			currentIndexingState.stage !== lastIndexingState.stage
		) {
			lastIndexingState = currentIndexingState;

			ctx.server.broadcastToSubscribed('indexProgress', {
				status: currentIndexingState.status,
				current: currentIndexingState.current,
				total: currentIndexingState.total,
				stage: currentIndexingState.stage,
				chunksProcessed: currentIndexingState.chunksProcessed,
				throttleMessage: currentIndexingState.throttleMessage,
			});
		}

		// Broadcast slot progress if any slot changed
		currentSlots.forEach((slot: SlotState, index: number) => {
			const lastSlot = lastSlots[index];
			if (
				!lastSlot ||
				slot.state !== lastSlot.state ||
				slot.batchInfo !== lastSlot.batchInfo ||
				slot.retryInfo !== lastSlot.retryInfo
			) {
				ctx.server.broadcastToSubscribed('slotProgress', {
					index,
					...slot,
				});
			}
		});
		lastSlots = currentSlots;
	});

	try {
		const stats = await ctx.owner.index({force: validated.force});

		// Broadcast completion
		ctx.server.broadcastToSubscribed('indexComplete', {
			success: true,
			stats,
		});

		return stats;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		// Broadcast failure
		ctx.server.broadcastToSubscribed('indexComplete', {
			success: false,
			error: message,
		});

		throw error;
	} finally {
		unsubscribe();
	}
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
	return ctx.owner.getWatcherStatus();
};

/**
 * Shutdown handler.
 * Broadcasts shutdown notification and schedules server stop.
 */
const shutdownHandler: Handler = async (params, ctx) => {
	const validated = shutdownParamsSchema.parse(params ?? {});

	console.error(
		`[daemon] Shutdown requested: ${validated.reason ?? 'no reason'}`,
	);

	// Broadcast shutdown notification
	ctx.server.broadcast('shuttingDown', {
		reason: validated.reason ?? 'shutdown requested',
	});

	// Schedule shutdown after response is sent
	setImmediate(async () => {
		await ctx.owner.shutdown();
		await ctx.server.stop();
		process.exit(0);
	});

	return {success: true};
};

/**
 * Subscribe handler.
 * Subscribes client to push notifications and returns current state.
 */
const subscribeHandler: Handler = async (params, ctx) => {
	const validated = subscribeParamsSchema.parse(params ?? {});

	// Check protocol version if provided
	if (
		validated.protocolVersion !== undefined &&
		validated.protocolVersion !== PROTOCOL_VERSION
	) {
		throw new JsonRpcMethodError(
			ErrorCodes.INVALID_PARAMS,
			`Protocol version mismatch: client=${validated.protocolVersion}, daemon=${PROTOCOL_VERSION}`,
		);
	}

	// Subscribe client
	ctx.server.subscribeClient(ctx.clientId);

	// Return current state
	const status = await ctx.owner.getStatus();
	const indexingState = selectIndexingState(store.getState());

	return {
		subscribed: true,
		protocolVersion: PROTOCOL_VERSION,
		status,
		indexingState: {
			status: indexingState.status,
			current: indexingState.current,
			total: indexingState.total,
			stage: indexingState.stage,
		},
	};
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
	const indexingState = selectIndexingState(store.getState());

	return {
		healthy: true,
		uptime: process.uptime(),
		memoryUsage: process.memoryUsage(),
		clients: ctx.server.getClientCount(),
		indexStatus: indexingState.status,
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
		status: statusHandler,
		watchStatus: watchStatusHandler,
		shutdown: shutdownHandler,
		subscribe: subscribeHandler,
		ping: pingHandler,
		health: healthHandler,
	};
}
