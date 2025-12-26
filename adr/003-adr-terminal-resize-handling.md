# ADR-003: Terminal Resize Handling for Ink Static Components

## Status

Accepted

## Context

Ink's `<Static>` component renders items once and commits them to the terminal buffer. On terminal resize, these items cannot reflow, causing visual corruption:

- StatusBar and TextInput stack/duplicate
- Static content becomes misaligned with new terminal dimensions
- User experience degrades significantly during window resizing

### How Other CLIs Handle This

**Claude Code** bundles a modified Ink with `ink2` mode that:

- Tracks `fullStaticOutput` containing all rendered ANSI output
- Clears terminal and rewrites `fullStaticOutput` when overflow detected

**Gemini CLI** uses a forked Ink (`@jrichman/ink`):

- Same pattern: tracks `fullStaticOutput`
- On resize/overflow: `clearTerminal + fullStaticOutput + currentOutput`

Both solutions require forking or bundling modified Ink internals.

### Constraints

1. **No Ink fork** - Maintain stock Ink v4 as dependency
2. **Preserve formatting** - Colors, layout, welcome banner must survive resize
3. **Minimal complexity** - Plugin-style solution with good separation of concerns

## Decision

Use React's key-based remounting to force `<Static>` to re-render all items on resize.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       App.tsx                                │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              StaticWithResize Component                 │ │
│  │                                                         │ │
│  │  useTerminalResize ──▶ onResize ──▶ clear terminal     │ │
│  │                                    setGeneration(g+1)   │ │
│  │                                                         │ │
│  │  <Static key={generation}> ◀── key change = remount    │ │
│  │      {items rendered by Ink}                            │ │
│  │  </Static>                                              │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Implementation

**`StaticWithResize` component** (`source/common/components/StaticWithResize.tsx`):

- Drop-in replacement for Ink's `<Static>`
- On resize: clears terminal with ANSI sequences, increments generation key
- Key change forces React to unmount/remount `<Static>`, re-rendering all items

**`useTerminalResize` hook** (`source/common/hooks/useTerminalResize.ts`):

- Subscribes to `process.stdout.on('resize')`
- Debounces rapid resize events (100ms)
- Provides current and previous dimensions

### Key Insight

Instead of capturing and replaying terminal output (Claude Code/Gemini approach), we let Ink re-render from source data:

```tsx
// Generation key forces remount on resize
<Static key={generation} items={items}>
	{item => <FormattedComponent {...item} />}
</Static>
```

When `generation` changes:

1. React unmounts the old `<Static>` instance
2. New instance mounts with fresh internal state
3. Ink re-renders all items with proper formatting

### Debouncing Strategy

```
Terminal resize event
        │
        ▼
useTerminalResize (100ms debounce)
        │
        ▼
handleResize callback (150ms debounce)
        │
        ▼
Clear terminal + setGeneration()
```

Total 250ms debounce ensures resize events fully settle before re-render.

## Consequences

### Positive

- **No Ink fork required** - Works with stock Ink v4
- **Preserves all formatting** - Ink re-renders with colors, layout, components
- **Simple implementation** - ~60 lines of code total
- **Composable** - Hook and component can be used independently
- **Future-proof** - Survives Ink upgrades

### Negative

- **Brief flash on resize** - Terminal clears before re-render (~150ms visible)
- **Full re-render** - All static items re-render, not just affected ones

### Neutral

- Different approach than Claude Code/Gemini CLI (remount vs replay)
- Requires items array to persist in parent state (already the case in our architecture)

## Alternatives Considered

### 1. Capture stdout writes

Intercept `stdout.write()` to capture actual ANSI output, replay on resize.

**Rejected**: Would capture dynamic components too (StatusBar, TextInput). Filtering static-only output requires Ink internals knowledge.

### 2. Fork Ink

Maintain custom Ink fork with `fullStaticOutput` tracking.

**Rejected**: Maintenance burden, upgrade friction, unnecessary complexity.

### 3. Store plain text buffer

Store item content as plain text, rewrite on resize.

**Rejected**: Loses formatting (colors, box layout, welcome banner). Tested and produced inferior results.
