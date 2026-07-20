# AGENTS.md

## Cursor SDK Reference

Authoritative documentation for the Cursor TypeScript SDK (including `Agent`, `Run`, `Cursor.models.list`, `ModelSelection`, and cloud options) is the official guide:

- **SDK docs:** [https://cursor.com/docs/api/sdk/typescript](https://cursor.com/docs/api/sdk/typescript)

If the local summary below is ambiguous or outdated, fetch that page (for example with `WebFetch`) and treat it as the source of truth.

### Topics covered there (non-exhaustive)

- Runtimes (local, cloud-hosted, cloud self-hosted)
- Authentication (`CURSOR_API_KEY`, user keys, service accounts)
- Core concepts (`Agent`, `Run`, `SDKMessage`)
- Installation and quick start
- Creating agents (`Agent.create`, `Agent.prompt`, `Agent.resume`)
- Sending messages, streaming, waiting, cancelling
- Stream event types (`assistant`, `thinking`, `tool_call`, `status`, `user`, `task`, `system`, `request`)
- Inspecting agents and runs (`Agent.list`, `Agent.listRuns`, `Agent.getRun`, `Agent.messages.list`)
- MCP server configuration
- Sub-agent definitions
- Hooks, artifacts, resource management
- `AgentOptions`, `CloudOptions`, `AgentDefinition`
- Model listing (`Cursor.models.list`), `ModelSelection`, parameters and variants
- Errors (`AuthenticationError`, `RateLimitError`, `ConfigurationError`, `NetworkError`, `UnsupportedRunOperationError`)

Agents working in this repo should load that documentation into context before reasoning about `@cursor/sdk` SDK behavior.

## Learned User Preferences

- Default cloud agent model should be Grok 4.5 high (non-fast); resolve the real id from `Cursor.models.list` (for example `cursor-grok-4.5-high`) before hardcoding — never invent suffix ids like `gpt-5.5-high`.
- The orchestrator Cloud Agent should delegate implementation to worker agents (repos, gists, code), not write product code itself.
- Plan "missing constraint" failures should auto-repair via a spawned fix agent so the run continues.
- Planner parallelism: put independent different-repo tasks in the same `parallel_group`; same-repo tasks may share a group when `allowed_paths` claims are disjoint (orchestrator fans task branches into one run branch / PR); serialize only for real ordering or shared artifacts.
- Orchestration v3: bounded iterate-until-clean (default `max_iterations` 10, override via config or `CURSOR_ORCH_MAX_ITERATIONS`); same-repo parallelism via claims + per-task branches + orchestrator fan-in; parallel `code_quality`, `code_review`, and `computer_use` gates after fan-in; computer-use tests target a local app in the cloud VM.

## Learned Workspace Facts

- CLI package is `cursor-orch` in repo `cursor-ca-orchestrator`: Node 20+ TypeScript CLI that orchestrates Cursor Cloud Agents across GitHub repos.
- Coordination uses a bootstrap GitHub board repo (commonly `cursor-orch-bootstrap`; `BOOTSTRAP_OWNER` / `BOOTSTRAP_REPO`) with per-run branches as the bulletin board.
- Agent runtime uses `@cursor/sdk` (not legacy `@cursor/february`); `/model` must use catalog ids plus params/variants.
- SaaS UI companion is a separate repo named `curcitric-orch` (Next.js + Supabase; plans use Stitch MCP for screens).
