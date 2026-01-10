/**
 * Bounded async channel with backpressure.
 *
 * Implements producer-consumer pattern where:
 * - Producer blocks when buffer is full (backpressure)
 * - Consumer blocks when buffer is empty
 * - Provides memory-bounded streaming between async operations
 *
 * Used in indexing pipeline to decouple batch building from embedding.
 */

/**
 * Bounded async channel for producer-consumer communication.
 *
 * @template T - Type of items in the channel
 */
export class BoundedChannel<T> {
	private buffer: T[] = [];
	private closed = false;
	private waitingPush: Array<{
		resolve: () => void;
		reject: (error: Error) => void;
	}> = [];
	private waitingPull: Array<{
		resolve: (value: T | null) => void;
	}> = [];

	/**
	 * Create a bounded channel.
	 * @param capacity - Maximum number of items in buffer (must be >= 1)
	 */
	constructor(private readonly capacity: number) {
		if (capacity < 1) {
			throw new Error('BoundedChannel capacity must be >= 1');
		}
	}

	/**
	 * Push an item to the channel.
	 * Blocks if buffer is full (backpressure).
	 *
	 * @throws Error if channel is closed
	 */
	async push(item: T): Promise<void> {
		if (this.closed) {
			throw new Error('Cannot push to closed channel');
		}

		// If there's a waiting consumer, deliver directly
		const consumer = this.waitingPull.shift();
		if (consumer) {
			consumer.resolve(item);
			return;
		}

		// If buffer has space, add to it
		if (this.buffer.length < this.capacity) {
			this.buffer.push(item);
			return;
		}

		// Buffer full - wait for space (backpressure)
		await new Promise<void>((resolve, reject) => {
			this.waitingPush.push({resolve, reject});
		});

		// After waking, add to buffer
		this.buffer.push(item);
	}

	/**
	 * Pull an item from the channel.
	 * Blocks if buffer is empty.
	 * Returns null when channel is closed and empty.
	 */
	async pull(): Promise<T | null> {
		// If buffer has items, return one
		if (this.buffer.length > 0) {
			const item = this.buffer.shift()!;
			// Wake a waiting producer
			const producer = this.waitingPush.shift();
			if (producer) {
				producer.resolve();
			}
			return item;
		}

		// If closed and empty, return null (signal completion)
		if (this.closed) {
			return null;
		}

		// Wait for item
		return new Promise<T | null>(resolve => {
			this.waitingPull.push({resolve});
		});
	}

	/**
	 * Close the channel.
	 * Remaining items can still be pulled, but no new items can be pushed.
	 */
	close(): void {
		this.closed = true;

		// Reject all waiting producers
		for (const producer of this.waitingPush) {
			producer.reject(new Error('Channel closed'));
		}
		this.waitingPush = [];

		// Resolve all waiting consumers with null
		for (const consumer of this.waitingPull) {
			consumer.resolve(null);
		}
		this.waitingPull = [];
	}

	/** Current number of items in buffer */
	get size(): number {
		return this.buffer.length;
	}

	/** Whether channel is closed */
	get isClosed(): boolean {
		return this.closed;
	}

	/** Maximum buffer capacity */
	get maxCapacity(): number {
		return this.capacity;
	}
}
