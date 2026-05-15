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
