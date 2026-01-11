/**
 * Redux store exports.
 *
 * Central export point for all store-related items:
 * - Store instance
 * - Type definitions
 * - Typed hooks
 * - Actions and selectors
 */

// Store and types
export {store, type RootState, type AppDispatch} from './store.js';

// Typed hooks
export {useAppDispatch, useAppSelector} from './hooks.js';

// Slot progress slice
export {
	SlotProgressActions,
	slotProgressReducer,
	type SlotState,
	type SlotProgressState,
	type FailedChunk,
} from './slot-progress/slice.js';

// Slot progress selectors
export {
	selectSlot,
	selectSlots,
	selectSlotCount,
	selectFailures,
	selectHasRateLimitedSlots,
} from './slot-progress/selectors.js';

// Indexing slice
export {
	IndexingActions,
	indexingReducer,
	type IndexingState,
	type IndexingStatus,
} from './indexing/slice.js';

// Indexing selectors
export {
	selectIndexingState,
	selectIndexingStatus,
	selectIndexingStage,
	selectIndexingCurrent,
	selectIndexingTotal,
	selectThrottleMessage,
	selectChunksProcessed,
	selectIndexingError,
	selectIsIndexing,
	selectIndexingPercent,
	selectIsThrottled,
	selectIndexingColor,
	selectIndexingDisplay,
} from './indexing/selectors.js';

// Warmup slice
export {
	WarmupActions,
	warmupReducer,
	type WarmupState,
	type WarmupStatus,
} from './warmup/slice.js';

// Watcher slice
export {
	WatcherActions,
	watcherReducer,
	type WatcherState,
	type WatcherStatus,
} from './watcher/slice.js';

// Wizard slice
export {
	WizardActions,
	wizardReducer,
	type WizardState,
	type WizardType,
	type McpSetupStep,
	type InitWizardConfig as WizardInitConfig,
	type McpSetupWizardConfig as WizardMcpConfig,
	type PartialInitConfig,
	type PartialMcpConfig,
} from './wizard/slice.js';

// Wizard selectors
export {
	selectWizardState,
	selectActiveWizard,
	selectInitStep,
	selectMcpStep,
	selectInitConfig,
	selectMcpConfig,
	selectIsReinit,
	selectShowMcpPrompt,
	selectExistingApiKey,
	selectExistingProvider,
	selectIsWizardActive,
	selectIsInitWizardActive,
	selectIsMcpWizardActive,
	selectIsCleanWizardActive,
} from './wizard/selectors.js';

// App slice
export {AppActions, appReducer, type AppState} from './app/slice.js';

// App selectors
export {
	selectAppState,
	selectIsInitialized,
	selectIndexStats,
	selectAppStatus,
	selectOutputItems,
	selectStartupLoaded,
	selectIsBusy,
	selectOutputCount,
} from './app/selectors.js';
