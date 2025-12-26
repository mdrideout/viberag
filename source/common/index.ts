/**
 * Common infrastructure for React/Ink CLI applications.
 * Generic components and hooks with no RAG-specific dependencies.
 */

// Types
export * from './types.js';

// Components
export {default as TextInput} from './components/TextInput.js';
export {default as StatusBar} from './components/StatusBar.js';
export {default as CommandSuggestions} from './components/CommandSuggestions.js';

// Hooks
export {useCtrlC} from './hooks/useCtrlC.js';
export {useCommandHistory} from './hooks/useCommandHistory.js';
export {useTextBuffer} from './hooks/useTextBuffer.js';
export {useKittyKeyboard} from './hooks/useKittyKeyboard.js';

// Commands
export {setupVSCodeTerminal} from './commands/terminalSetup.js';
