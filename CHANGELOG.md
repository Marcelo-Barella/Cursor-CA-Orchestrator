# Changelog

## 2.1.0 - 2026-04-28

- **Planner inventory manifest v1:** New optional `inventory` block (and sidecar `inventory_file: <path>`) on the orchestrator config declares `product_class`, `layers`, `explicit_deferrals`, `required_integrations`, `greenfield`, and optional `repo_hints`. When present, it is embedded in the planner user prompt (`## Inventory` block) and is authoritative for which product layers and integrations the plan must cover. `parseConfig` now accepts an `inventoryBaseDir` so sidecar paths resolve relative to the loaded config; `Session.load` and `resolveConfigPrecedence` pass the config directory automatically.
- **Planner prompt completeness rules:** Planner system prompt gains a COMPLETENESS step requiring every inventory `layers` entry to map to at least one task ID (capped at 20 tasks); without an inventory, the planner defaults to client + server/API + persistence for a web app unless the user request uses explicit scoping terms. "MVP", "v1", and "prototype" cannot be used to drop a layer unless the user prompt says so. `explicit_deferrals` may only contain user-stated, narrow concerns and must not be invented.
- **Worker prompt scope guard:** Worker system prompt instructs agents not to reinterpret tasks as a minimal/MVP slice and not to remove other layers' contracts unless the task prompt explicitly authorizes it.
- **CLI:** `cursor-orch inventory -o <path>` writes a default `declared`, `greenfield: true` web_app manifest (`client`, `api`, `persistence` + `accounts`) for users to edit and reference from `inventory_file`.
- **REPL:** `/prompt-set` description now points greenfield users at the inventory block in saved YAML.
- **Tests:** `tests/planner-prompt-inventory.test.ts` covers planner prompt rendering with/without an inventory; `tests/system-prompt-strings.test.ts` locks in the new planner/worker scope strings; `tests/config.test.ts` adds `validateInventory` cases plus parse coverage for inline manifest, sidecar-only manifest, and inline-overrides-sidecar merge.
- **Cleanup:** Removed leftover localhost debug fetch instrumentation from `src/lib/github-consolidated-pr.ts` (`mergeBranches` and `openPullRequestForRunBranch`).

## 2.0.2 - 2026-04-23

- Fix plan ref and SDK `startingRef` for consolidated run-line and per-task worker launches.
- Fix repo-creation prompt when using consolidated run-line (example run branch in instructions).
- **Failure / cascade debugging:** `state.json` task agents include `cascade_source_task_id` when a failure is only due to an upstream task; `status` and `logs --run` print a “Failure analysis” block (root vs cascaded, suggested `logs --run … --task <root>`); `logs --task` notes cascaded tasks with no worker transcript; the watch TUI status bar shows root task ids. Legacy runs without the new field still classify cascades from the `Upstream task … failed` summary.
- Tests: parallel delegation overlap coverage, `startingRef` expectations, fake client concurrent-send tracking, and `failure-diagnostics` unit tests.

## 2.0.1 - 2026-04-22

- Minor bug fixes

## 2.0.0 - 2026-04-17

- **Documentation:** The Cloud Agent TypeScript SDK is documented at [cursor.com/docs/cloud-agent/typescript-sdk](https://cursor.com/docs/cloud-agent/typescript-sdk).
- **Breaking — Cursor SDK migration:** Dropped the bespoke REST client at `https://api.cursor.com/v0/agents`. Both the local CLI and the cloud orchestrator runtime now drive agents through the official Cursor TypeScript SDK (`@cursor/february`) via a new `src/sdk/agent-client.ts` seam (`AgentClient`, `buildCloudAgentOptions`, `streamToCallbacks`, `parseAssistantJsonFromText`, `tryDownloadJsonArtifact`). `src/api/cursor-client.ts` is removed.
- **Stream-driven workers:** Each worker launch is `Agent.create({ cloud: { repos, branchName, autoCreatePR } })` + `agent.send(prompt)` + `run.stream()` + `run.wait()`. The orchestrator no longer polls the Cursor API on a 30-second cadence; completion is detected by awaiting `run.wait()` per worker. SDK events stream into a new `transcripts/<task_id>.jsonl` on the run branch (one record per `SDKMessage`), and key events mirror into `events.jsonl` as `worker_status` / `worker_tool_call`.
- **Worker output protocol:** Workers no longer shell out `gh api PUT` to write `agent-<task_id>.json`. They write `cursor-orch-output.json` into the workspace root (primary, read via `agent.listArtifacts()` + `agent.downloadArtifact()`) and include the same JSON as a fenced ```json block in their final assistant message (fallback, parsed from the SDK stream). The orchestrator normalizes, truncates, and writes the canonical `agent-<task_id>.json` itself.
- **Follow-ups (retry-blocked):** Use `sdkAgent.send(followUpPrompt)` on the retained `SDKAgent`, preserving conversation. Replaces the old `CursorClient.sendFollowup` REST call.
- **Stop semantics:** `cursor-orch stop` writes `stop-requested.json`; the orchestrator disposes SDK agents on its next iteration and marks state `stopped`. The SDK's `Run.cancel()` is unsupported for cloud runs and is documented as a known limitation.
- **Bootstrap runtime install:** `BOOTSTRAP_INSTALL_COMMAND` is now `npm install --no-save --no-audit --no-fund --prefix . @cursor/february@<version>`; the SDK version is pulled from `package.json` at build time and exported as `REQUIRED_SDK_SPEC` / `REQUIRED_SDK_VERSION` in `src/packager.ts`. esbuild bundles the orchestrator runtime with `@cursor/february`, `sqlite3`, and the `@connectrpc/connect{,-node}` packages marked as externals. Manifest schema bumps to `version: "3"` and gains `sdk_package`, `sdk_version`, `sdk_spec`.
- **CLI:** `cursor-orch run` launches the orchestrator through the SDK (`Agent.create({ cloud: ... }).send(launchPrompt)`) and exits after the cloud agent is live, preserving the offline-safe workflow. Launch prompt exports `CURSOR_ORCH_SDK_SPEC` / `CURSOR_ORCH_SDK_VERSION`.
- **Logs:** `cursor-orch logs --run <id> --task <task_id>` reads from `transcripts/<task_id>.jsonl` (SDK event stream with role-colored rendering). Without `--task` it reads the orchestrator's `events.jsonl`. `CURSOR_API_KEY` is no longer required for `logs`.
- **Prompts / system prompt:** Worker + repo-creation prompts point at the new artifact protocol; system prompts drop Gist-era wording.
- **Planner:** Unchanged text-write path (`task-plan.json` on the run branch) with an SDK-based fallback (`Agent.listRuns` + `RunResult.result`) when the file is missing.
- **Tests:** New `tests/sdk-agent-client.test.ts`, `tests/transcript.test.ts`, `tests/orchestrator-e2e.test.ts`, plus `tests/support/fake-agent-client.ts`. Existing tests updated to the SDK-based shape; `CursorClient` references removed.

## 0.6.0 - 2026-04-14

- **CLI:** On a TTY, missing required environment variables are prompted once, written to `.env` in the working directory, and exported for the process; non-TTY runs exit with a clear list. Interactive mode and `run`, `status`, `stop`, `logs`, and `cleanup` declare which keys are required before oclif runs.
- **Planner:** Downstream `__new__` tasks without `depends_on` can be linked to the correct `create_repo` task when task ids suggest frontend vs backend and names disambiguate the two creators.
- **Validation:** `validateRepoRefs` skips non-`create_repo` tasks whose `repo` is `__new__` (already tied to a creator via dependencies).
- **Constraints:** Constraint lines are matched with the regex capture span; task prompts are checked against the normalized constraint key derived from that phrase (not a truncated line prefix).

## 0.5.8 - 2026-04-09

- **Tests:** Expanded coverage for parallel-group concurrency, failed upstream as terminal for wave advance, post-map defensive eligibility, corrupted delegation cursors, `parseTaskPlan` + `validateConfig` on incomplete delegation map, and `validateConfig` early return when `prompt` is set and `tasks` is empty.

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