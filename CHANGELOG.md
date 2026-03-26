# Changelog

## Unreleased

## 0.4.3 - 2026-03-26
- **Repository remove:** removing a repository by URL now matches the configured `url` when the argument is a full URL, not only the map key (alias).

## 0.4.2 - 2026-03-26
- **TTY multiline prompt:** raw-mode line editor for the interactive REPL and guided setup when stdin is a TTY—**Ctrl+J** (LF) or **Alt+Enter** (ESC+CR) inserts a newline; **Enter** submits. Bracketed paste passes embedded newlines as text. Parses CSI `u` / `27;13;~` enter events where the terminal sends them.
- **History file:** REPL history stores entries as JSON lines so multiline prompts round-trip; legacy plain lines still load.
- **Slash commands:** multi-line input that starts with `/` is rejected with a short hint (slash commands must be one line).
- **Docs in-app:** setup and REPL banner explain that **Shift+Enter** is the same as **Enter** in typical integrated terminals (e.g. VS Code/Cursor), so use Ctrl+J or Alt+Enter for a new line.

## 0.3.2 - 2026-03-24
- Published the 0.3.2 release.
- Refined CLI output styling and refreshed dependencies for a cleaner terminal experience.

## 0.3.1 - 2026-03-23
- Standardized npm binary path handling.
- Bumped package version to 0.3.1.

## 0.3.0 - 2026-03-23
- Completed migration to a TypeScript-based npm package.
- Removed the legacy Python implementation.
- Published the first npm-era release.

## Pre-0.3.0 Foundations - 2026-03-09 to 2026-03-17
- Established the orchestration foundation with configuration, state management, API integrations, runtime flow, and CLI documentation.
- Consolidated early multi-agent orchestration work into a unified execution milestone.
- Added an interactive REPL and high-level task planning for easier run setup and control.
- Strengthened bootstrap safety with clearer read-only repository rules and safer execution guidance.
- Improved planning reliability for downstream `__new__` tasks and idempotent planning behavior.
- Streamlined first-run onboarding and strengthened diagnostics throughout the run lifecycle.
- Pinned bootstrap runtime references for more reproducible orchestration behavior.
- Moved orchestration storage from gist-backed artifacts to run-branch storage.
- Improved automatic wiring for `__new__` tasks and planner bootstrap-context handoff.
