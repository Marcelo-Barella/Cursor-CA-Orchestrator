# Changelog

## Unreleased

## 0.4.8 - 2026-03-27

- **REPL:** `/prompt` prints the full orchestration prompt and copies it to the clipboard (terminal OSC52 or host tools such as `wl-copy` / `xclip` / `pbcopy` when available); `/config clear` resets the session to defaults; guided setup and config defaults use `composer-2` where applicable; `/repo` rejects empty alias or URL; slash-completion includes `/config clear` as an explicit suggestion.

## 0.4.7 - 2026-03-26

- **Status watch (TTY):** `cursor-orch status --run <id> --watch` opens a blessed live dashboard (task table, event log, header, status bar) when stdout is a TTY and progress is not quiet; otherwise it uses the inline polling view.
- **Completion mode:** on terminal orchestration states (`completed`, `failed`, `stopped`), the TTY dashboard stays open until user exit (`q` or `Ctrl+C`) with explicit status-bar guidance, and non-TTY inline mode prints the final static snapshot and exits without a timed teardown.
- **Launch progress:** non-quiet TTY runs show a short animated tangerine-style progress sequence while the run is starting.
- **npm:** Published as `cursor-orch@0.4.7` on npm (0.4.4, 0.4.5, and 0.4.6 were not published).

## 0.4.6 - 2026-03-26

- **Orchestrator repository targeting:** task repository fields resolve GitHub HTTPS URLs, `owner/repo` shorthand, normalized URL variants, and fuzzy alias matches by URL or repository name when unique; dependency handoff uses `repo_ref` from upstream outputs when provided.
- **Delegation phases:** planner and runtime support `delegation_map` phased launch groups with validation for duplicates, unknown tasks, and impossible dependency ordering.
- **Worker launch failures:** failed agent launches now persist detailed API error text plus repository URL and ref in run state and events.

## 0.4.5 - 2026-03-26

- **Planner:** resolve planner task repository fields to the canonical configured alias.

## 0.4.4 - 2026-03-26

- **Config validation:** normalize GitHub repository URL references (strip `.git`, trailing slashes); validate repositories and fuzzy-match aliases by URL or repository name when the match is unique.

## 0.4.3 - 2026-03-26

- **Repository remove:** removing a repository by URL now matches the configured `url` when the argument is a full URL, not only the map key (alias).
- **npm:** Published as `cursor-orch@0.4.3` on npm.

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
