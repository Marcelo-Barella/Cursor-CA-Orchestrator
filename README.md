# cursor-orch

A Python CLI that orchestrates multiple Cursor Cloud Agents working across different GitHub repositories. It provisions a bootstrap repo, creates a per-run Gist as a coordination bulletin board, and launches an orchestrator Cloud Agent that manages worker agents targeting your repositories.

## Prerequisites

- Python 3.11+
- `CURSOR_API_KEY` -- API key for Cursor Cloud Agents
- `GH_TOKEN` -- GitHub personal access token with `repo` scope (for bootstrap repo) and `gist` scope (for Gist operations)

## Installation

```bash
pip install -e .
```

## Quick Start

```bash
# Set environment variables
export CURSOR_API_KEY=key_abc...
export GH_TOKEN=ghp_xyz...

# Launch the interactive REPL
cursor-orch

# Check status of a running orchestration (one-shot)
cursor-orch status --gist GIST_ID

# Watch live dashboard
cursor-orch status --gist GIST_ID --watch

# View agent conversation logs
cursor-orch logs --gist GIST_ID
cursor-orch logs --gist GIST_ID --task my-task-id

# Stop a running orchestration
cursor-orch stop --gist GIST_ID
```

## Interactive REPL

Running `cursor-orch` with no arguments launches an interactive REPL where you configure repositories, set a prompt, and start an orchestration run -- all from a single session.

The REPL persists your session to `~/.cursor-orch/session.yaml` so you can resume where you left off.

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
| `/repo remove` | `/repo remove <alias>` | Remove a repository by alias |
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
| Local CLI  |---creates----->| Per-Run Gist     |<---r/w--->| Orchestrator      |
|            |                | - config.yaml    |           | Cloud Agent       |
|            |---ensures----->| - state.json     |           |   (runs loader    |
|            |                | - summary.md     |           |    from bootstrap |
|            |---launches---->| - manifest.json  |           |    repo, loads    |
|            |                | - runtime__*.py  |           |    runtime from   |
|            |---polls------->| - agent-*.json   |           |    Gist)          |
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

1. **Local CLI** -- Runs in your terminal. Provides the interactive REPL, creates config, provisions the bootstrap repo, creates a per-run Gist with runtime code, launches the orchestrator agent, and provides a dashboard.

2. **Bootstrap Repo** -- A minimal private repo in your GitHub account (`cursor-orch-bootstrap`). Contains a loader script and a Cursor rule. The rule is dynamically generated before each run with credentials. The loader fetches and verifies runtime code from the Gist.

3. **Cloud Agents** -- The orchestrator agent runs against the bootstrap repo, executes the loader, and manages the task graph. Worker agents run against your target repositories, each receiving a self-contained prompt with task instructions and a Python helper to report results via the Gist.

### Per-Run Gist

Each orchestration run creates a fresh private Gist that serves as a coordination bulletin board:

- **CLI writes once:** config.yaml, runtime files, manifest
- **Orchestrator writes:** state.json, summary.md, events.jsonl
- **Workers write:** agent-{task_id}.json (their individual output files)
- **CLI stop signal:** stop-requested.json

Every file has exactly one writer. No concurrent writes to any file.

## Limitations

- Maximum 20 tasks per orchestration run
- Workers are fully isolated and cannot communicate with each other
- Orchestration logic is reactive polling (30-second intervals), not event-driven
- GitHub Gist size limits apply (10MB per file, ~300 files per Gist)
- Runtime payload (all orchestration code) must be under 1MB combined
- Worker output per task capped at 512KB with automatic truncation
- Rate limits: GitHub API (5,000 req/hour), Cursor API (conservative estimates)
- The bootstrap repo Cursor rule contains literal credentials (repo must stay private)
