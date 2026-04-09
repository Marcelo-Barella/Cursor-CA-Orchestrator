# Changelog

## Unreleased

## 0.5.7 - 2026-04-09

- **REPL:** `/tokens` prints a GPT-4o tokenizer estimate for the configured orchestration prompt; `/prompt set` acknowledgment includes token count.

## 0.5.6 - 2026-04-09

- **Planner prompts:** Clarify that dependency ordering against later phases or parallel groups is rejected by config validation before the orchestration loop; system prompt states consolidated same-repo tasks belong in different parallel groups; within-group launch order is not guaranteed (use `depends_on` for sequencing). Worker and planner prompts no longer pass or embed GitHub tokens; planner instructions use `gh` and preconfigured credentials.

## 0.5.5 - 2026-04-09

- **Delegation extraction:** Scheduling uses task ids from `config.tasks` when building delegation phases so runtime extraction matches validated config. When `delegation_map.phases` is non-empty but produces no groups after filtering task ids, extraction returns null instead of falling through to the legacy path that merged parallel groups into one group per phase.

## 0.5.4 - 2026-04-08

- **Run-line orchestration:** With `target.branch_layout: consolidated` and `target.consolidate_prs`, workers share one run branch per repo group (`{branch_prefix}/{run_id}/{plan_ref}/run`); the first task launches from the plan ref, later tasks from the run branch; consolidated PR opening uses `openPullRequestForRunBranch` when finished agents agree on the run branch, otherwise the prior integration-branch merge path applies. `repo_run_head` updates after tasks finish when set.
- **Worker prompts:** Run-line launches add a GIT TARGET section (push the run branch only, do not open a PR) and adjusted rules; the planner notes same-repo serialization across parallel groups for consolidated PR mode.
- **Docs:** README `target.consolidate_prs` describes run-line branches, PR behavior, and the `delegation_map` requirement for same-repo multi-task runs.

## 0.5.3 - 2026-04-08

- **Validation:** Under consolidated layout with consolidated PRs, `validateConfig` requires `delegation_map` when multiple tasks target the same repository alias, forbids two such tasks in the same parallel group, and exports `canonicalRepoAliasForTask` for consistent repo resolution.

## 0.5.2 - 2026-04-08

- **State:** `repo_run_head` records the per-repo-group run branch name for resume and launch ref selection (serialized with run state).

## 0.5.1 - 2026-04-08

- **GitHub run-line helpers:** Added `runBranchName`, `ensureRunBranchFromBase`, and `openPullRequestForRunBranch` for consolidated run branches (create from base when missing, sync base into run branch, open PR from run branch).

## 0.5.0 - 2026-04-07

- **Consolidated PRs:** With `target.auto_create_pr` and `target.consolidate_prs` (default true), worker launches skip per-task PR creation; when all tasks finish, the orchestrator merges task branches into one integration branch per GitHub repo and opens a single PR per repo. `CURSOR_ORCH_CONSOLIDATE_PRS` overrides the boolean. Summary output and the TTY dashboard list consolidated PR URLs (and errors) when present.
- **Branch layout:** `target.branch_layout` is `consolidated` (default) or `per_task`; `per_task` enforces validation of `branch_prefix/task_id` segments. `CURSOR_ORCH_BRANCH_LAYOUT` overrides.
- **GitHub helpers:** New `src/lib/github-consolidated-pr.ts` (merge API flow, integration branch naming, topo-sort for merge order) and `parseGithubOwnerRepo` in `repo-target`.
- **Run preflight:** `cursor-orch run` validates `GH_TOKEN` against the GitHub API before starting orchestration.
- **Delegation validation enforcement:** Orchestration fails fast through `validateConfig` before scheduling starts, including planner-produced `config.yaml` paths.
- **Config precedence:** `resolveConfigPrecedence` carries `delegation_map` into the merged config so delegation validation applies consistently in `run` and `config doctor`.
- **Delegation semantics:** Runtime eligibility enforces ordered phase and parallel-group waves; tasks outside `delegation_map` are not eligible while waves are active when a map is present. Dependency ordering checks treat only **later** parallel groups in the same phase as invalid (earlier groups are allowed).
- **Delegation completeness:** `validateConfig` requires every configured task to appear exactly once in `delegation_map` when it is set.
- **State resume:** `delegation_group_index` is serialized and deserialized with `delegation_phase_index` for deterministic resume. Agent state records `branch_name` for consolidation. `deserialize` normalizes legacy agent objects.
- **REPL:** `/consolidate-prs [on|off]` toggles `target.consolidate_prs`; setup summary and `/config` show the flag.
- **Planner / prompts:** Planner instructions and system prompt describe wave ordering, full task coverage in `delegation_map`, and dependency alignment with phases and groups.

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
