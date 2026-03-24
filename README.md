# cursor-orch

A TypeScript CLI for Node.js 20+ that orchestrates multiple Cursor Cloud Agents working across different GitHub repositories. It provisions a bootstrap repo, uses per-run branches on that repo as a coordination bulletin board, and launches an orchestrator Cloud Agent that manages worker agents targeting your repositories.

## Prerequisites

- Node.js 20+ (for install, build, tests, and CLI execution)
- GitHub personal access token for `GH_TOKEN` with `repo` scope for bootstrap repository creation and updates
- Cursor API key for `CURSOR_API_KEY`
- For `status`, `logs`, and `stop` against an existing run, set `BOOTSTRAP_OWNER` and `BOOTSTRAP_REPO` to the GitHub owner and repository name of your bootstrap repo (same values used in the run output)

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

Running `cursor-orch` with no arguments launches an interactive REPL where you configure repositories, set a prompt, and start an orchestration run -- all from a single session.

The REPL persists your session to `~/.cursor-orch/session.yaml` so you can resume where you left off.

In a normal terminal (interactive stdin and stdout), the main prompt shows **live slash suggestions** while you type: after a leading `/`, all commands appear; as you add characters before the first space, the list filters by prefix (case-insensitive). The list shows up to ten entries with a hint if more match. Piped or non-interactive stdin keeps classic line-at-a-time input with no suggestion panel. Guided setup and `/prompt` multi-line capture are unchanged. Use `/help` for the full command reference at any time.

### Example Session

```
$ cursor-orch

  cursor-orch v0.1.0
  Type /help for available commands.

> /name jwt-migration
  Name set: jwt-migration

> /repo auth-svc https://github.com/acme/auth-service main
  Repository added: auth-svc

> /prompt
  Enter orchestration prompt (end with empty line):
  | Migrate from session-based auth to JWT across all services.
  |
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
| `/prompt` | `/prompt` | Enter a multi-line prompt interactively |
| `/branch-prefix` | `/branch-prefix <prefix>` | Set the branch name prefix |
| `/auto-pr` | `/auto-pr [on\|off]` | Toggle or set automatic PR creation |
| `/bootstrap-repo` | `/bootstrap-repo <name>` | Set the bootstrap repository name |
| `/config` | `/config` | Show current configuration summary |
| `/save` | `/save [path]` | Save config to file or session |
| `/load` | `/load <path>` | Load config from a YAML file |
| `/run` | `/run` | Validate and start the orchestration |
| `/help` | `/help` | Show available commands |
| `/clear` | `/clear` | Clear the terminal |
| `/exit` | `/exit` | Exit the REPL |

## Single-Prompt Mode

In single-prompt mode you provide a high-level prompt describing what you want done, along with the set of repositories involved. The orchestrator decomposes the prompt into individual tasks using a planner agent and dispatches them to worker agents targeting the appropriate repos.

1. Add repositories with `/repo`.
2. Describe the goal with `/prompt`.
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
| `target.branch_prefix` | string | yes | Prefix for worker branch names |

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

1. **Local CLI** -- Runs in your terminal. Provides the interactive REPL, creates config, provisions the bootstrap repo, creates a per-run branch with runtime files, launches the orchestrator agent, and provides a dashboard.

2. **Bootstrap Repo** -- A minimal private repo in your GitHub account (`cursor-orch-bootstrap`). Contains Cursor rules and pinned runtime files on dedicated refs. The orchestrator agent runs `node dist/orchestrator-runtime.cjs` with environment variables pointing at the run branch.

3. **Cloud Agents** -- The orchestrator agent runs against the bootstrap repo and manages the task graph. Worker agents run against your target repositories, each receiving a self-contained prompt with task instructions and shell steps to report results via the run branch.

### Per-Run Branch

Each orchestration run creates a branch `run/<run_id>` on the bootstrap repository that serves as a coordination bulletin board:

- **CLI writes once:** config.yaml, runtime files, manifest
- **Orchestrator writes:** state.json, summary.md, events.jsonl
- **Workers write:** agent-{task_id}.json (their individual output files)
- **CLI stop signal:** stop-requested.json

Every file has exactly one writer. No concurrent writes to any file.

## Limitations

- Maximum 20 tasks per orchestration run
- Workers are fully isolated and cannot communicate with each other
- Orchestration logic is reactive polling (30-second intervals), not event-driven
- GitHub repository and API limits apply (file size, rate limits)
- Runtime payload (all orchestration code) must be under 1MB combined
- Worker output per task capped at 512KB with automatic truncation
- Rate limits: GitHub API (5,000 req/hour), Cursor API (conservative estimates)
- The bootstrap repo Cursor rule contains literal credentials (repo must stay private)

## Publishing (maintainers)

npm releases are automated by [.github/workflows/publish.yml](.github/workflows/publish.yml). Each push to `main` runs the workflow, which compares `package.json` `version` to the npm registry via `npm view` and runs `npm publish` only when the local version is semver-greater than the published version. If the package is not on the registry yet, the workflow treats the remote version as `0.0.0`, so the first publish is supported.

Add a GitHub Actions repository secret named exactly `NODE_AUTH_TOKEN` with an [npm automation token](https://docs.npmjs.com/about-access-tokens). To ship a release, bump `version` in `package.json` on `main` and push; publishing happens only when that version exceeds what is already published.
