# ADR-001: VS Code Terminal Shift+Enter Newline Support

## Status

Accepted

## Context

VibeRAG provides a terminal UI built with React Ink that accepts multi-line input. Users need a way to insert newlines without submitting the input. The primary target environment is VS Code's integrated terminal, with compatibility required for other terminals (iTerm2, Kitty, macOS Terminal, etc.).

The challenge is that different terminals handle Shift+Enter differently:
- **VS Code Terminal**: Does not natively distinguish Shift+Enter from Enter
- **Kitty/WezTerm**: Support the Kitty keyboard protocol, sending CSI u sequences
- **iTerm2**: Supports CSI u when "Report modifiers using CSI u" is enabled
- **macOS Terminal**: No Shift+Enter support

We need to match Claude Code's behavior, which successfully handles Shift+Enter in VS Code terminal.

## Decision

We implement a multi-layered approach for newline insertion:

### 1. VS Code Keybinding Configuration (`/terminal-setup` command)

The `/terminal-setup` command writes a keybinding to VS Code's `keybindings.json`:

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b\n" },
  "when": "terminalFocus"
}
```

This sends ESC (0x1B) + LF (0x0A) to the terminal when Shift+Enter is pressed.

### 2. Input Detection in TextInput Component

The detection handles multiple scenarios:

#### Scenario A: ESC+LF/CR Unrecognized Sequence

Ink's `parseKeypress` receives the 2-character string `\x1b\n` but doesn't recognize it as a special sequence:
- It checks `s === '\r'` and `s === '\n'` which fail (string is 2 chars)
- `keypress.name` stays empty
- `useInput` sets `key.return = false` (because `name !== 'return'`)
- ESC prefix is stripped, leaving `input = '\n'` or `'\r'`

**Detection logic:**
```typescript
if (
  (input === '\n' || input === '\r') &&
  !key.return &&  // Key: distinguishes from plain Enter
  !key.ctrl &&
  !key.shift
) {
  insertNewline();
}
```

#### Scenario B: Terminals with Proper ESC Parsing

Some terminals/configurations may set `key.escape` or `key.meta` to true:

```typescript
if ((key.escape || key.meta) && (input === '\n' || input === '\r')) {
  insertNewline();
}
```

#### Scenario C: Timing-based ESC+Enter Detection

For terminals that send ESC and Enter as separate events:

```typescript
if (key.escape && !input) {
  escPressedTimeRef.current = Date.now();
  // Clear input after 150ms if no Enter follows
}

if (key.return && Date.now() - escPressedTimeRef.current < 150) {
  insertNewline();
}
```

### 3. Universal Fallback Methods

- **Backslash + Enter**: Type `\` then press Enter
- **Ctrl+J**: Sends raw LF (0x0A), caught by ESC+LF detection since `key.return = false`
- **Shift+Enter** (Kitty terminals): Native support via `key.return && key.shift`
- **Option+Enter** (macOS): Via `key.return && key.meta`

## Architecture: End-to-End Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         User presses Shift+Enter                     │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    VS Code Keybinding Triggered                      │
│                                                                      │
│  keybindings.json:                                                   │
│  {                                                                   │
│    "key": "shift+enter",                                             │
│    "command": "workbench.action.terminal.sendSequence",              │
│    "args": { "text": "\u001b\n" }                                    │
│  }                                                                   │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Terminal PTY Layer                                │
│                                                                      │
│  Sends raw bytes: 0x1B 0x0A (ESC + LF)                              │
│  May translate to: 0x1B 0x0D (ESC + CR) depending on terminal mode   │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Node.js stdin (raw mode)                          │
│                                                                      │
│  stdin.setRawMode(true)                                              │
│  stdin.setEncoding('utf8')                                           │
│  Receives: "\x1b\n" or "\x1b\r" as Buffer/String                     │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Ink's parseKeypress()                             │
│                                                                      │
│  Input: "\x1b\n" (2 chars)                                           │
│                                                                      │
│  Checks (all fail for 2-char string):                               │
│  - s === '\r'  → false                                               │
│  - s === '\n'  → false                                               │
│  - metaKeyCodeRe.exec(s)  → null (\n not alphanumeric)              │
│  - fnKeyRe.exec(s)  → null (not ANSI sequence)                       │
│                                                                      │
│  Result: keypress.name = '' (empty), sequence = '\x1b\n'             │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Ink's useInput hook                               │
│                                                                      │
│  key.return = (keypress.name === 'return')  → false                  │
│  key.escape = (keypress.name === 'escape')  → false                  │
│  key.meta = keypress.meta || ...  → false                            │
│                                                                      │
│  input = keypress.sequence  → '\x1b\n'                               │
│  if (input.startsWith('\x1b')) input = input.slice(1)                │
│  input = '\n'                                                        │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    TextInput Component                               │
│                                                                      │
│  Receives: input = '\n', key.return = false                          │
│                                                                      │
│  Detection:                                                          │
│  if ((input === '\n' || input === '\r') && !key.return) {            │
│    insertNewline();  // ✓ Matched!                                   │
│  }                                                                   │
└─────────────────────────────────────────────────────────────────────┘
```

## Comparison with Claude Code

Claude Code uses Bun's runtime with a generator-based `emitKeys` function (from Node.js readline):

```javascript
// Claude Code's approach (Bun/Node readline)
function* emitKeys(stream) {
  while (true) {
    let ch = yield;
    let escaped = false;

    if (ch === '\x1b') {
      escaped = true;
      ch = yield;  // Get next char
    }

    if (ch === '\r')
      key.name = 'return', key.meta = escaped;
    else if (ch === '\n')
      key.name = 'enter', key.meta = escaped;
  }
}
```

The generator processes characters one-by-one, maintaining `escaped` state between yields. When ESC comes first, the next character inherits `key.meta = true`.

Our Ink-based approach receives the full buffer at once, requiring different detection logic but achieving the same result.

## Terminal Compatibility Matrix

| Terminal | Shift+Enter Method | Status |
|----------|-------------------|--------|
| VS Code (with /terminal-setup) | ESC+LF keybinding | Works |
| Kitty | Native CSI u | Works |
| WezTerm | Native CSI u | Works |
| iTerm2 (CSI u enabled) | Native CSI u | Works |
| iTerm2 (default) | Option+Enter or `\ + Enter` | Works |
| macOS Terminal | `\ + Enter` or Ctrl+J | Works |
| Any terminal | Ctrl+J | Works |
| Any terminal | `\ + Enter` | Works |

## Files Modified

- `source/cli/components/TextInput.tsx` - Input handling with ESC+LF/CR detection
- `source/cli/commands/terminalSetup.ts` - Terminal detection and VS Code keybinding setup
- `source/cli/hooks/useCommands.ts` - Command registration
- `source/cli/app.tsx` - App integration

## Consequences

### Positive

- Shift+Enter works identically to Claude Code in VS Code terminal
- Multiple fallback methods ensure newline insertion works in any terminal
- `/terminal-setup` command provides automatic configuration
- Clean detection logic that doesn't interfere with normal Enter (submit)

### Negative

- Requires one-time `/terminal-setup` command for VS Code users
- Detection relies on Ink's parseKeypress leaving `key.return = false` for unrecognized sequences (implementation detail)

### Neutral

- Ctrl+J sends raw LF which is caught by the same ESC+LF detection (both have `key.return = false`)
