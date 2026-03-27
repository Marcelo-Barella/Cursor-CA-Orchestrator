# TUI exit / live dashboard - discovery notes

## Entry: TTY vs inline
- `renderLive` (`src/dashboard.ts`) uses `renderLiveTUI` only when `process.stdout.isTTY && !isQuietProgress()`; otherwise it uses `renderLiveInline`.
- `isQuietProgress` (`src/tui/progress.ts`) is true if `CURSOR_ORCH_QUIET` is `1` or `true`.
- `renderLive` is called from `src/lib/commands/run-impl.ts` and `src/commands/status.ts`.

## Terminal detection (orchestration `state.status`)
- `TERMINAL_STATES = new Set(["completed", "failed", "stopped"])` appears in both `src/dashboard.ts` and `src/tui/live-loop.ts`.
- `dashboard.ts` uses it via `pollOnce` to set `terminal: TERMINAL_STATES.has(state.status)`.
- `live-loop.ts` uses it in the main loop after `deserialize`.
- The duplicated constants are currently aligned but can drift.

## TUI path (`renderLiveTUI` in `src/tui/live-loop.ts`)
- Loop: `loadRunConfigSnapshot` -> read `state.json` -> `readEvents` -> `updateAll` -> `screen.render()`.
- On terminal state: `await delay(2000)` -> `screen.destroy()` -> break.
- On errors: `screen.destroy()` then rethrow.
- Poll cadence uses `POLL_INTERVAL = 10` seconds; waiting loop checks `refreshRequested` to support `r`.

## Layout teardown (user initiated)
- `buildLayout` (`src/tui/layout.ts`) binds `q` and `C-c` to `screen.destroy(); process.exit(0);`.
- Resize triggers a render via `screen.on("resize", ...)`.

## Inline path (`renderLiveInline` in `src/dashboard.ts`)
- Loop: `loadRunConfigSnapshot` -> `pollOnce` -> `console.clear()` -> `renderSnapshot(...)`.
- On terminal state: `await delay(2000)` then break.
- The final visible output is the last rendered snapshot, then process returns after the delay.

## Summary
- Both paths detect terminal states the same way and both pause for 2 seconds before exiting.
- TUI explicitly destroys the screen; inline mode does not print an additional completion block after the loop.
