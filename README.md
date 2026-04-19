# cursor-orch

A TypeScript CLI for Node.js 20+ that orchestrates multiple Cursor Cloud Agents working across different GitHub repositories. It provisions a bootstrap repo, uses per-run branches on that repo as a coordination bulletin board, and launches an orchestrator Cloud Agent that drives worker agents through the official Cursor TypeScript SDK (`@cursor/february`).

## Prerequisites

- Node.js 20+ (for install, build, tests, and CLI execution)
- GitHub personal access token for `GH_TOKEN` with `repo` scope for bootstrap repository creation and updates
- Cursor API key for `CURSOR_API_KEY`
- For `status`, `logs`, and `stop` against an existing run, set `BOOTSTRAP_OWNER` and `BOOTSTRAP_REPO` to the GitHub owner and repository name of your bootstrap repo (same values used in the run output)

The bootstrap orchestrator installs `@cursor/february` at launch time inside the cloud VM (the CLI bundle pins the version). That SDK ships native `sqlite3` and vendored `rg` binaries, so the install can take a couple of minutes on a cold start.

## Onboarding: Clone to First Run

```bash
git clone https://github.com/<your-org>/cursor-ca-orchestrator.git
cd cursor-ca-orchestrator
cp .env.example .env
```

Edit `.env` and set:

- `CURSOR_API_KEY=...`
- `GH_TOKEN=...`

Run one-command bootstrap:

```bash
bash scripts/bootstrap.sh
```

Expected smoke output includes:

- `Bootstrapping environment`
- `Installing dependencies`
- `Building cursor-orch`
- `Running smoke check: node ./dist/cli.js --help`
- `Bootstrap complete`

If bootstrap fails due to missing credentials, re-check `.env` values and token scopes in prerequisites.

Immediate next actions:

- Start interactive setup: `cursor-orch`
- Validate effective config and token discovery first: `cursor-orch config doctor --strict`
- Run with config in non-interactive mode: `cursor-orch run --config ./orchestrator.yaml`
- Run with explicit bootstrap repo when needed: `cursor-orch run --config ./orchestrator.yaml --bootstrap-repo cursor-orch-bootstrap`
- If credentials are missing, run with inline envs: `CURSOR_API_KEY=... GH_TOKEN=... cursor-orch run --config ./orchestrator.yaml`

## Manual Install and Smoke

```bash
npm install
npm run build
node ./dist/cli.js --help
```

Global install (optional):

```bash
npm install -g .
cursor-orch --help
```

## Quick Start

```bash

# Launch the interactive REPL
cursor-orch

# Validate config precedence and required values
cursor-orch config doctor --strict

# Start a run from YAML config
cursor-orch run --config ./orchestrator.yaml

# Check status of a running orchestration (one-shot)
cursor-orch status --run RUN_ID

# Watch live dashboard
cursor-orch status --run RUN_ID --watch

# View agent conversation logs
cursor-orch logs --run RUN_ID
cursor-orch logs --run RUN_ID --task my-task-id

# Stop a running orchestration
cursor-orch stop --run RUN_ID
```

After `cursor-orch run`, copy the printed run ID and use it with `status`, `logs`, and `stop`. Set `BOOTSTRAP_OWNER` and `BOOTSTRAP_REPO` to match your bootstrap repository.

If a command fails, use this quick recovery path:

- Error format is standardized as: `[SEVERITY] <CODE> <TITLE>`.
- `What happened`: read the one-line cause and identify the missing input or inaccessible resource.
- `Next step`: run the single recommended fix shown in output first.
- `Non-interactive alternative`: use the script-safe form for CI or shell automation.
- `Example`: copy the exact command example from output and replace placeholders.

Core command discoverability and immediate next actions:

| Command | Purpose | Immediate next action | Automation-oriented example |
|---------|---------|-----------------------|-----------------------------|
| `cursor-orch run --config ./orchestrator.yaml` | Start orchestration | `cursor-orch status --run <run_id> --watch` | `CURSOR_API_KEY=... GH_TOKEN=... cursor-orch run --config /workspace/orchestrator.yaml --bootstrap-repo cursor-orch-bootstrap` |
| `cursor-orch status --run <run_id>` | Read current run state | `cursor-orch logs --run <run_id>` | `GH_TOKEN=... cursor-orch status --run <run_id> --watch` |
| `cursor-orch logs --run <run_id>` | Read orchestrator conversation | `cursor-orch status --run <run_id>` | `CURSOR_API_KEY=... GH_TOKEN=... cursor-orch logs --run <run_id> --task <task_id>` |
| `cursor-orch stop --run <run_id>` | Request graceful stop | `cursor-orch status --run <run_id> --watch` | `CURSOR_API_KEY=... GH_TOKEN=... cursor-orch stop --run <run_id>` |

Core command help:

```bash
cursor-orch run --help
cursor-orch status --help
cursor-orch logs --help
cursor-orch stop --help
cursor-orch config doctor --help
```

## Shell Autocomplete

`cursor-orch` includes the oclif autocomplete plugin, so you can print shell-specific setup instructions directly from the CLI:

```bash
cursor-orch autocomplete
cursor-orch autocomplete bash
cursor-orch autocomplete zsh
cursor-orch autocomplete powershell
```

The command prints the install steps for your current shell. After enabling it, tab completion includes command names, flags, and space-separated topics such as `cursor-orch config doctor`.

If you want colon-style topic completion instead, regenerate the setup with:

```bash
OCLIF_AUTOCOMPLETE_TOPIC_SEPARATOR=colon cursor-orch autocomplete
```

## Interactive REPL

Running `cursor-orch` with no arguments launches an interactive REPL where you configure repositories, set the orchestration prompt, and start a run -- all from a single session.

At the `>` prompt, a line that does **not** start with `/` is treated as the orchestration prompt text (you can paste multi-line text in one submission where the terminal supports it). Lines that **do** start with `/` are slash commands.

The REPL persists your session to `~/.cursor-orch/session.yaml` so you can resume where you left off.

In a normal terminal (interactive stdin and stdout), the main prompt shows **live slash suggestions** while you type: after a leading `/`, all commands appear; as you add characters before the first space, the list filters by prefix (case-insensitive). **Tab** expands the longest shared prefix across matches when possible; otherwise it inserts the **highlighted** command. Use **Up / Down** to move the highlight when more than one match is shown (the line text does not follow the highlight until you press **Tab**). With a **single** matching command, **Up / Down** stay on **input history**; use **Tab** to complete that command. **Enter** always submits the current line as shown. The list scrolls a window of up to ten rows when there are many matches, with a footer showing the range. Piped or non-interactive stdin keeps classic line-at-a-time input with no suggestion panel. Guided setup uses the same rule: non-slash input sets the prompt. Use `/help` for the full command reference at any time. The `/repo remove` form appears in the list alongside `/repo-remove` (same behavior).

### Example Session

```
$ cursor-orch

  cursor-orch v0.1.0
  Type /help for available commands.

> /name jwt-migration
  Name set: jwt-migration

> /repo auth-svc https://github.com/acme/auth-service main
  Repository added: auth-svc

> Migrate from session-based auth to JWT across all services.
  Prompt set (57 characters)

> /run
  Validating config...
```

## Slash Commands

| Command | Usage | Description |
|---------|-------|-------------|
| `/name` | `/name <session-name>` | Set the session name |
| `/model` | `/model <model-name>` | Set the AI model to use |
| `/repo` | `/repo <alias> <url> [ref]` | Add or replace a repository |
| `/repo-remove` | `/repo-remove <alias>` | Remove a repository (also `/repo remove <alias>`) |
| `/repos` | `/repos` | List all configured repositories |
| `/prompt-set` | `/prompt-set <text>` | Set the orchestration prompt text directly |
| `/branch-prefix` | `/branch-prefix <prefix>` | Set the branch name prefix |
| `/auto-pr` | `/auto-pr [on\|off]` | Toggle or set automatic PR creation |
| `/consolidate-prs` | `/consolidate-prs [on\|off]` | Toggle one consolidated PR per repo at end (with Auto PR on) |
| `/bootstrap-repo` | `/bootstrap-repo <name>` | Set the bootstrap repository name |
| `/config` | `/config` or `/config clear` | Show current configuration summary, or reset all settings to defaults |
| `/save` | `/save [path]` | Save config to file or session |
| `/load` | `/load <path>` | Load config from a YAML file |
| `/run` | `/run` | Validate and start the orchestration |
| `/help` | `/help` | Show available commands |
| `/clear` | `/clear` | Clear the terminal |
| `/exit` | `/exit` | Exit the REPL |

## Single-Prompt Mode

In single-prompt mode you provide a high-level prompt describing what you want done, along with the set of repositories involved. The orchestrator decomposes the prompt into individual tasks using a planner agent and dispatches them to worker agents targeting the appropriate repos.

1. Add repositories with `/repo`.
2. Describe the goal at `>` (plain text, not a slash command), or use `/prompt-set <text>`.
3. Run with `/run` -- the planner agent breaks the prompt into tasks and assigns each to a repository.

This lets you express cross-repo changes in a single natural-language statement instead of writing individual task definitions by hand.

## CI / Non-Interactive Mode

For CI pipelines or scripted usage, pass a pre-built YAML config directly:

```bash
cursor-orch run --config orchestration.yaml
```

The config file must contain the full orchestration definition including repositories, tasks, and target settings. See the Configuration Reference below.

## Configuration Reference

```yaml
name: "my-orchestration"

model: "default"

bootstrap_repo_name: "cursor-orch-bootstrap"

prompt: |
  Describe the high-level goal for the orchestrator.
  The planner agent will decompose this into individual tasks.

repositories:
  my-repo:
    url: "https://github.com/your-org/your-repo"
    ref: "main"

tasks:
  - id: "example-task"
    repo: "my-repo"
    prompt: |
      Describe what this task should accomplish.
    depends_on: []
    model: "default"
    timeout_minutes: 30

target:
  auto_create_pr: true
  consolidate_prs: true
  branch_prefix: "cursor-orch"
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable name for the orchestration |
| `model` | string | no | Default model for agents (default: "default") |
| `bootstrap_repo_name` | string | no | Name of bootstrap repo (default: "cursor-orch-bootstrap") |
| `prompt` | string | no | High-level goal for single-prompt mode; the planner decomposes this into tasks |
| `repositories` | map | yes | Map of repo aliases to URL + ref |
| `tasks` | list | yes | List of task definitions (max 20) |
| `tasks[].id` | string | yes | Unique task identifier (alphanumeric, dots, hyphens) |
| `tasks[].repo` | string | yes | Repository alias from `repositories` |
| `tasks[].prompt` | string | yes | Task description sent to the worker agent |
| `tasks[].depends_on` | list | no | Task IDs that must complete first |
| `tasks[].model` | string | no | Per-task model override |
| `tasks[].timeout_minutes` | int | no | Task timeout in minutes (default: 30) |
| `target.auto_create_pr` | bool | no | Auto-create PRs for worker branches (default: true) |
| `target.consolidate_prs` | bool | no | When `auto_create_pr` is true, defer PRs and open one PR per GitHub repo at the end (default: true). With `branch_layout: consolidated`, workers push to a single run branch per repo (`{branch_prefix}/{run_id}/{ref}/run`); the orchestrator merges the base ref into that branch then opens the PR. Otherwise task branches are merged as before. Multi-repo runs yield one PR per repo. Same-repo multi-task runs need `delegation_map` with one task per parallel group for that repo. |
| `target.branch_prefix` | string | yes | Prefix for worker branch names |

Environment variable `CURSOR_ORCH_CONSOLIDATE_PRS` overrides `target.consolidate_prs` when set to a boolean string (`true` / `false` / `1` / `0` / `yes` / `no` / `on` / `off`).

## Architecture

```
User Terminal                     GitHub                          Cursor Cloud
+------------+                +------------------+           +-------------------+
| Local CLI  |---creates----->| Run branch       |<---r/w--->| Orchestrator      |
|            |                | - config.yaml    |           | Cloud Agent       |
|            |---ensures----->| - state.json     |           |   (runs loader    |
|            |                | - summary.md     |           |    from bootstrap |
|            |---launches---->| - manifest.json  |           |    repo, loads    |
|            |                | - dist/*.cjs     |           |    runtime from   |
|            |---polls------->| - agent-*.json   |           |    run branch)    |
+------------+                | - events.jsonl   |           |                   |
                              +------------------+           +---+---------------+
                              +------------------+               |
                              | Bootstrap Repo   |               | launches
                              | (user's GitHub)  |<--clones------+
                              | - loader script  |               |
                              | - cursor rule    |               v
                              +------------------+           +---+---------------+
                                                             | Worker Agents     |
                                                             | (one per task,    |
                                                             |  target repos)    |
                                                             +-------------------+
```

### Three Components

1. **Local CLI** -- Runs in your terminal. Provides the interactive REPL, creates config, provisions the bootstrap repo, creates a per-run branch with runtime files, and launches the orchestrator agent via the Cursor TypeScript SDK. Exits once the orchestrator is running; the cloud agent continues independently.

2. **Bootstrap Repo** -- A minimal private repo in your GitHub account (`cursor-orch-bootstrap`). Contains Cursor rules and a pinned runtime snapshot (`dist/orchestrator-runtime.cjs` + `package.json`) on a `runtime/<sha>` ref. The orchestrator agent first runs `npm install --no-save @cursor/february@<pinned>` to pull the SDK into the cloud VM, then starts `node dist/orchestrator-runtime.cjs`.

3. **Cloud Agents** -- The orchestrator agent drives the task graph using `@cursor/february` -- every worker launch is `Agent.create({ cloud: { repos, branchName, autoCreatePR } })` followed by `run.stream()` and `run.wait()`. Worker results arrive as workspace artifacts (`cursor-orch-output.json`, read via `agent.listArtifacts()` + `agent.downloadArtifact()`), with the same JSON also included as a fenced ```json block in the final assistant message as a fallback.

### Per-Run Branch

Each orchestration run creates a branch `run/<run_id>` on the bootstrap repository that serves as a coordination bulletin board:

- **CLI writes once:** config.yaml, runtime files, manifest, secrets.json
- **Orchestrator writes:** state.json, summary.md, events.jsonl, transcripts/<task_id>.jsonl, agent-<task_id>.json (the orchestrator pulls the worker's artifact and writes the canonical file itself)
- **CLI stop signal:** stop-requested.json

Every file has exactly one writer. No concurrent writes to any file.

## Limitations

- Maximum 20 tasks per orchestration run
- Workers are fully isolated and cannot communicate with each other
- The Cursor SDK does not yet support cloud-run cancellation; `cursor-orch stop` writes a sentinel file (`stop-requested.json`) and the orchestrator disposes each worker's SDK handle on its next iteration -- remote workloads may continue until they naturally complete or hit their timeout
- GitHub repository and API limits apply (file size, rate limits)
- Runtime payload (our own orchestration bundle) must be under 1MB combined; the SDK itself is fetched at agent startup and not counted here
- Worker output per task capped at 512KB with automatic truncation
- Rate limits: GitHub API (5,000 req/hour), Cursor API (governed by the SDK)
- The bootstrap repo Cursor rule contains literal credentials (repo must stay private)

## Publishing (maintainers)

npm releases are automated by [.github/workflows/publish.yml](.github/workflows/publish.yml). Each push to `main` runs the workflow, which compares `package.json` `version` to the npm registry via `npm view` and runs `npm publish` only when the local version is semver-greater than the published version. If the package is not on the registry yet, the workflow treats the remote version as `0.0.0`, so the first publish is supported.

Add a GitHub Actions repository secret named exactly `NODE_AUTH_TOKEN` with an [npm automation token](https://docs.npmjs.com/about-access-tokens). To ship a release, bump `version` in `package.json` on `main` and push; publishing happens only when that version exceeds what is already published.
