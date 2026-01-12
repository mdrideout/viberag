/**
 * Memoized selectors for wizard state.
 */

import {createSelector} from '@reduxjs/toolkit';
import type {
	WizardState,
	WizardType,
	McpSetupStep,
	PartialInitConfig,
	PartialMcpConfig,
} from './slice.js';
import type {EmbeddingProviderType} from '../../../common/types.js';

// ============================================================================
// Root State Type (matches store.ts RootState)
// ============================================================================

type RootState = {
	wizard: WizardState;
};

// ============================================================================
// Basic Selectors
// ============================================================================

export const selectWizardState = (state: RootState): WizardState =>
	state.wizard;

export const selectActiveWizard = (state: RootState): WizardType | null =>
	state.wizard.active;

export const selectInitStep = (state: RootState): number =>
	state.wizard.initStep;

export const selectMcpStep = (state: RootState): McpSetupStep =>
	state.wizard.mcpStep;

export const selectInitConfig = (state: RootState): PartialInitConfig =>
	state.wizard.initConfig;

export const selectMcpConfig = (state: RootState): PartialMcpConfig =>
	state.wizard.mcpConfig;

export const selectIsReinit = (state: RootState): boolean =>
	state.wizard.isReinit;

export const selectShowMcpPrompt = (state: RootState): boolean =>
	state.wizard.showMcpPrompt;

export const selectExistingApiKey = (state: RootState): string | null =>
	state.wizard.existingApiKey;

export const selectExistingProvider = (
	state: RootState,
): EmbeddingProviderType | null => state.wizard.existingProvider;

// ============================================================================
// Memoized Selectors
// ============================================================================

/**
 * Check if any wizard is active.
 */
export const selectIsWizardActive = createSelector(
	[selectActiveWizard],
	(active): boolean => active !== null,
);

/**
 * Check if init wizard is active.
 */
export const selectIsInitWizardActive = createSelector(
	[selectActiveWizard],
	(active): boolean => active === 'init',
);

/**
 * Check if MCP setup wizard is active.
 */
export const selectIsMcpWizardActive = createSelector(
	[selectActiveWizard],
	(active): boolean => active === 'mcp-setup',
);

/**
 * Check if clean wizard is active.
 */
export const selectIsCleanWizardActive = createSelector(
	[selectActiveWizard],
	(active): boolean => active === 'clean',
);
