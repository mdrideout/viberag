# ADR-001: Cross-Terminal Shift+Enter Newline Support

## Status

Accepted

## Context

VibeRAG provides a terminal UI built with React Ink that accepts multi-line input. Users need a way to insert newlines without submitting the input. The solution must work across multiple terminals: iTerm2, VS Code, Kitty, WezTerm, and macOS Terminal.

The challenge is that terminals handle Shift+Enter differently:

- **iTerm2/Kitty/WezTerm**: Support the Kitty keyboard protocol when enabled
- **VS Code Terminal**: Does not support Kitty protocol; requires custom keybinding
- **macOS Terminal**: No Shift+Enter support

## Decision

We implement a two-pronged approach:

### 1. Kitty Keyboard Protocol (Primary)

On app startup, we enable the Kitty keyboard protocol by sending `\x1b[>1u` to stdout. This tells compatible terminals to send modifier-aware key sequences.

**File**: `source/common/hooks/useKittyKeyboard.ts`

```typescript
const KITTY_ENABLE = '\x1b[>1u'; // Enable progressive enhancement mode 1
const KITTY_DISABLE = '\x1b[<u'; // Pop/disable keyboard mode

export function useKittyKeyboard() {
	const {stdout} = useStdout();

	useEffect(() => {
		stdout.write(KITTY_ENABLE);
		return () => stdout.write(KITTY_DISABLE);
	}, [stdout]);
}
```

When enabled, terminals send CSI u encoded sequences:

- Shift+Enter → `\x1b[13;2u` (keycode=13, modifier=2/Shift)
- Alt+Enter → `\x1b[13;3u` (modifier=3/Alt)

### 2. VS Code Keybinding Fallback

VS Code's terminal does not support the Kitty keyboard protocol. The `/terminal-setup` command writes a keybinding to VS Code's `keybindings.json`:

```json
{
	"key": "shift+enter",
	"command": "workbench.action.terminal.sendSequence",
	"args": {"text": "\u001b\n"},
	"when": "terminalFocus"
}
```

This sends ESC+LF when Shift+Enter is pressed, which we detect separately.

### 3. Input Detection

**File**: `source/common/components/TextInput.tsx`

```typescript
useInput((input, key) => {
	// CSI u detection (iTerm2/Kitty/WezTerm with Kitty protocol)
	// Ink strips ESC prefix, leaving: [13;2u or [13;3u
	if (input === '[13;2u' || input === '[13;3u') {
		insertNewline();
		return;
	}

	// ESC+LF/CR detection (VS Code via /terminal-setup)
	// Ink doesn't recognize \x1b\n, so key.return = false and input = '\n'
	if ((input === '\n' || input === '\r') && !key.return) {
		insertNewline();
		return;
	}

	// Ctrl+J (universal fallback)
	if (key.ctrl && input === 'j') {
		insertNewline();
		return;
	}

	// Backslash + Enter (universal fallback)
	if (key.return && charBeforeCursor === '\\') {
		deleteBackslash();
		insertNewline();
		return;
	}
});
```

## Architecture: Kitty Protocol Flow (iTerm2/Kitty/WezTerm)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         App Startup                                  │
│                                                                      │
│  useKittyKeyboard() sends: \x1b[>1u                                 │
│  (Enable Kitty keyboard protocol, progressive enhancement mode 1)   │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  User presses Shift+Enter                           │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│              Terminal (iTerm2/Kitty/WezTerm)                        │
│                                                                      │
│  Kitty protocol enabled → sends CSI u sequence:                     │
│  \x1b[13;2u (ESC [ keycode ; modifiers u)                           │
│  keycode=13 (Enter), modifiers=2 (Shift)                            │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Ink's useInput hook                               │
│                                                                      │
│  parseKeypress doesn't recognize CSI u format                       │
│  keypress.name = '' → key.return = false                            │
│  input = '\x1b[13;2u' → ESC stripped → '[13;2u'                     │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    TextInput Component                               │
│                                                                      │
│  if (input === '[13;2u' || input === '[13;3u') {                    │
│    insertNewline();  // ✓ Matched!                                   │
│  }                                                                   │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         App Exit                                     │
│                                                                      │
│  useKittyKeyboard cleanup sends: \x1b[<u                            │
│  (Disable Kitty keyboard protocol)                                  │
└─────────────────────────────────────────────────────────────────────┘
```

## Architecture: VS Code Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│            User runs /terminal-setup (one-time)                     │
│                                                                      │
│  Writes to keybindings.json:                                        │
│  { "key": "shift+enter", "args": { "text": "\u001b\n" } }          │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  User presses Shift+Enter                           │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│              VS Code Terminal                                        │
│                                                                      │
│  Keybinding triggers → sends: \x1b\n (ESC + LF)                     │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Ink's useInput hook                               │
│                                                                      │
│  parseKeypress doesn't recognize \x1b\n                             │
│  keypress.name = '' → key.return = false                            │
│  input = '\x1b\n' → ESC stripped → '\n'                             │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    TextInput Component                               │
│                                                                      │
│  if ((input === '\n' || input === '\r') && !key.return) {           │
│    insertNewline();  // ✓ Matched!                                   │
│  }                                                                   │
└─────────────────────────────────────────────────────────────────────┘
```

## Terminal Compatibility Matrix

| Terminal       | Shift+Enter Works | Method            | User Action Required       |
| -------------- | ----------------- | ----------------- | -------------------------- |
| iTerm2         | Yes               | Kitty protocol    | None (automatic)           |
| Kitty          | Yes               | Kitty protocol    | None (automatic)           |
| WezTerm        | Yes               | Kitty protocol    | None (automatic)           |
| VS Code        | Yes               | ESC+LF keybinding | Run `/terminal-setup` once |
| macOS Terminal | No                | N/A               | Use `\ + Enter` or Ctrl+J  |

### Universal Fallback Methods (all terminals)

| Method       | How It Works                                                  |
| ------------ | ------------------------------------------------------------- |
| `\` + Enter  | Backslash detected and removed, newline inserted              |
| Ctrl+J       | Sends raw LF (0x0A), detected via `key.ctrl && input === 'j'` |
| Option+Enter | Detected via `key.meta && key.return`                         |

## Files Modified

- `source/common/hooks/useKittyKeyboard.ts` - Enables/disables Kitty keyboard protocol
- `source/cli/app.tsx` - Calls useKittyKeyboard hook on mount
- `source/common/components/TextInput.tsx` - CSI u and ESC+LF detection
- `source/common/commands/terminalSetup.ts` - VS Code keybinding setup, terminal detection

## Consequences

### Positive

- Shift+Enter works automatically in iTerm2, Kitty, and WezTerm (no user configuration)
- VS Code works after one-time `/terminal-setup` command
- Multiple fallback methods ensure newline insertion works in any terminal
- Protocol is cleanly disabled on app exit

### Negative

- VS Code still requires `/terminal-setup` (doesn't support Kitty protocol)
- macOS Terminal.app has no Shift+Enter support (must use fallbacks)
- Detection relies on Ink's parseKeypress leaving `key.return = false` for unrecognized sequences

### Neutral

- Terminals that don't support Kitty protocol simply ignore the enable sequence
