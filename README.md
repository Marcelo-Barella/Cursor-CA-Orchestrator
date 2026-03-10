# cursor-orch

A Python CLI that orchestrates multiple Cursor Cloud Agents working across different GitHub repositories. It provisions a bootstrap repo, creates a per-run Gist as a coordination bulletin board, and launches an orchestrator Cloud Agent that manages worker agents targeting your repositories -- all from a single YAML configuration file.

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

# Initialize config and bootstrap repo
cursor-orch init --config ./my-project.yaml

# Start an orchestration run
cursor-orch run

# Check status (one-shot)
cursor-orch status --gist GIST_ID

# Watch live dashboard
cursor-orch status --gist GIST_ID --watch

# View agent conversation logs
cursor-orch logs --gist GIST_ID
cursor-orch logs --gist GIST_ID --task my-task-id

# Stop a running orchestration
cursor-orch stop --gist GIST_ID
```

## Configuration Reference

```yaml
# Name for this orchestration run
name: "my-orchestration"

# Default model for all agents
model: "default"

# Bootstrap repo name (created in your GitHub account)
bootstrap_repo_name: "cursor-orch-bootstrap"

# Repositories involved in this orchestration
repositories:
  my-repo:
    url: "https://github.com/your-org/your-repo"
    ref: "main"

# Tasks to execute
tasks:
  - id: "example-task"
    repo: "my-repo"
    prompt: |
      Describe what this task should accomplish.
    depends_on: []          # list of task IDs this depends on
    model: "default"        # optional per-task model override
    timeout_minutes: 30     # optional timeout

# Target branch and PR settings
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

1. **Local CLI** -- Runs in your terminal. Creates config, provisions the bootstrap repo, creates a per-run Gist with runtime code, launches the orchestrator agent, and provides a dashboard.

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
