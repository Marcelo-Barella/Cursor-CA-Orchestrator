# AGENTS.md

## Cursor SDK Reference

The full reference for the `@cursor/february` TypeScript SDK is captured in Notion for persistent agent context:

- **Notion page**: [Cursor SDK February](https://www.notion.so/348e0d0138a7817280e5f70290f4ad5d)
- **Notion page ID**: `348e0d01-38a7-8172-80e5-f70290f4ad5d`
- **Upstream source**: [https://cursor.com/docs/api/sdk/typescript](https://cursor.com/docs/api/sdk/typescript)

### How to Retrieve

Use the Notion MCP server (`plugin-notion-workspace-notion`) to fetch the page whenever SDK context is needed.

#### Option 1: Fetch by ID (preferred)

```
CallMcpTool(
  server = "plugin-notion-workspace-notion",
  toolName = "notion-fetch",
  arguments = { "id": "348e0d01-38a7-8172-80e5-f70290f4ad5d" }
)
```

#### Option 2: Search by title

```
CallMcpTool(
  server = "plugin-notion-workspace-notion",
  toolName = "notion-search",
  arguments = { "query": "Cursor SDK February", "query_type": "internal" }
)
```

#### Option 3: Refetch upstream

If the Notion page is out of date, refresh from the canonical source:

```
WebFetch(url = "https://cursor.com/docs/api/sdk/typescript")
```

Then update the Notion page via `notion-update-page` using the same page ID.

### What the Page Covers

- Overview and runtimes (local, cloud-hosted, cloud self-hosted)
- Authentication (`CURSOR_API_KEY`, user keys, service accounts)
- Core concepts (`Agent`, `Run`, `SDKMessage`)
- Installation and quick start
- Creating agents (`Agent.create`, `Agent.prompt`, `Agent.resume`)
- Sending messages, streaming events, waiting, cancelling
- Stream event types (`assistant`, `thinking`, `tool_call`, `status`, `user`, `task`, `system`, `request`)
- Inspecting agents and runs (`Agent.list`, `Agent.listRuns`, `Agent.getRun`, `Agent.messages.list`)
- MCP server configuration (local stdio/HTTP/SSE and cloud HTTP/stdio)
- Sub-agent definitions
- Hooks, artifacts, resource management
- Full `AgentOptions`, `CloudOptions`, `AgentDefinition` reference
- Errors (`AuthenticationError`, `RateLimitError`, `ConfigurationError`, `NetworkError`, `UnsupportedRunOperationError`)
- Known limitations and surface-area cheat sheet

Agents working in this repo should load the Notion page into context before reasoning about `@cursor/february` SDK behavior.
