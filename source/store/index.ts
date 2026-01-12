/**
 * Redux store exports.
 *
 * CLI-only Redux store for wizard and app state.
 * Daemon state is managed separately via daemon/state.ts.
 */

// Store and types
export {store, type RootState, type AppDispatch} from './store.js';

// Typed hooks
export {useAppDispatch, useAppSelector} from './hooks.js';

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
