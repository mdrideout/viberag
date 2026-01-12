/**
 * Redux slice for wizard state.
 *
 * Manages the state machine for wizard flows (init, mcp-setup, clean).
 * Components dispatch actions to navigate steps; reducers handle transitions.
 */

import {createSlice, type PayloadAction} from '@reduxjs/toolkit';
import type {
	EmbeddingProviderType,
	InitWizardConfig,
	McpSetupWizardConfig,
	McpSetupStep,
} from '../../../common/types.js';

// ============================================================================
// Types
// ============================================================================

export type WizardType = 'init' | 'mcp-setup' | 'clean';

// Re-export types for consumers
export type {
	McpSetupStep,
	InitWizardConfig,
	McpSetupWizardConfig,
} from '../../../common/types.js';

// Partial config types for wizard state (fields get filled in as wizard progresses)
export type PartialInitConfig = Partial<InitWizardConfig>;
export type PartialMcpConfig = Partial<McpSetupWizardConfig>;

export interface WizardState {
	/** Currently active wizard type, or null if no wizard active */
	active: WizardType | null;
	/** Current step for init wizard (0-based) */
	initStep: number;
	/** Current step for mcp-setup wizard */
	mcpStep: McpSetupStep;
	/** Config accumulated during init wizard */
	initConfig: PartialInitConfig;
	/** Config accumulated during mcp-setup wizard */
	mcpConfig: PartialMcpConfig;
	/** Whether this is a reinit (existing config) */
	isReinit: boolean;
	/** Whether to show prompt step in MCP wizard */
	showMcpPrompt: boolean;
	/** Existing API key for reinit flow */
	existingApiKey: string | null;
	/** Existing provider for reinit flow */
	existingProvider: EmbeddingProviderType | null;
}

// ============================================================================
// Initial State
// ============================================================================

const initialState: WizardState = {
	active: null,
	initStep: 0,
	mcpStep: 'select',
	initConfig: {},
	mcpConfig: {},
	isReinit: false,
	showMcpPrompt: false,
	existingApiKey: null,
	existingProvider: null,
};

// ============================================================================
// Slice
// ============================================================================

export const wizardSlice = createSlice({
	name: 'wizard',
	initialState,
	reducers: {
		// ========================================
		// Init Wizard Actions
		// ========================================

		/**
		 * Start the init wizard.
		 */
		startInit: (
			state,
			action: PayloadAction<{
				isReinit: boolean;
				existingApiKey?: string;
				existingProvider?: EmbeddingProviderType;
			}>,
		) => {
			state.active = 'init';
			state.initStep = 0;
			state.initConfig = {};
			state.isReinit = action.payload.isReinit;
			state.existingApiKey = action.payload.existingApiKey ?? null;
			state.existingProvider = action.payload.existingProvider ?? null;
		},

		/**
		 * Navigate to a step in init wizard with optional config update.
		 */
		setInitStep: (
			state,
			action: PayloadAction<{
				step: number;
				config?: PartialInitConfig;
			}>,
		) => {
			if (state.active === 'init') {
				state.initStep = action.payload.step;
				if (action.payload.config) {
					state.initConfig = {...state.initConfig, ...action.payload.config};
				}
			}
		},

		/**
		 * Update init config without changing step.
		 */
		updateInitConfig: (state, action: PayloadAction<PartialInitConfig>) => {
			if (state.active === 'init') {
				state.initConfig = {...state.initConfig, ...action.payload};
			}
		},

		// ========================================
		// MCP Setup Wizard Actions
		// ========================================

		/**
		 * Start the MCP setup wizard.
		 */
		startMcpSetup: (state, action: PayloadAction<{showPrompt: boolean}>) => {
			state.active = 'mcp-setup';
			state.mcpStep = action.payload.showPrompt ? 'prompt' : 'select';
			state.mcpConfig = {};
			state.showMcpPrompt = action.payload.showPrompt;
		},

		/**
		 * Navigate to a step in MCP wizard with optional config update.
		 */
		setMcpStep: (
			state,
			action: PayloadAction<{
				step: McpSetupStep;
				config?: PartialMcpConfig;
			}>,
		) => {
			if (state.active === 'mcp-setup') {
				state.mcpStep = action.payload.step;
				if (action.payload.config) {
					state.mcpConfig = {...state.mcpConfig, ...action.payload.config};
				}
			}
		},

		/**
		 * Update MCP config without changing step.
		 */
		updateMcpConfig: (state, action: PayloadAction<PartialMcpConfig>) => {
			if (state.active === 'mcp-setup') {
				state.mcpConfig = {...state.mcpConfig, ...action.payload};
			}
		},

		// ========================================
		// Clean Wizard Actions
		// ========================================

		/**
		 * Start the clean wizard.
		 */
		startClean: state => {
			state.active = 'clean';
		},

		// ========================================
		// Common Actions
		// ========================================

		/**
		 * Close the current wizard (cancel or complete).
		 */
		close: () => initialState,

		/**
		 * Set existing config for reinit flow (loaded on app startup).
		 */
		setExistingConfig: (
			state,
			action: PayloadAction<{
				apiKey?: string;
				provider?: EmbeddingProviderType;
			}>,
		) => {
			state.existingApiKey = action.payload.apiKey ?? null;
			state.existingProvider = action.payload.provider ?? null;
		},
	},
});

export const WizardActions = wizardSlice.actions;
export const wizardReducer = wizardSlice.reducer;
