import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cmdMcp } from "../src/commands.js";
import { Session } from "../src/session.js";
import { isMcpInteractiveInvocation } from "../src/repl.js";

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("cmdMcp", () => {
  it("list shows 'No MCP servers configured' when empty", () => {
    const session = new Session();
    expect(stripAnsi(cmdMcp(session, "list"))).toContain("No MCP servers configured");
  });

  it("list redacts secret-shaped header and env values", () => {
    const session = new Session();
    session.setMcpServer("linear", {
      type: "http",
      url: "https://mcp.linear.app/sse",
      headers: { Authorization: "Bearer super-secret", "X-Trace": "ok" },
    });
    session.setMcpServer("gh", {
      type: "stdio",
      command: "npx",
      env: { GITHUB_TOKEN: "ghp_xxx", DEBUG: "1" },
    });
    const out = stripAnsi(cmdMcp(session, "list"));
    expect(out).not.toContain("Bearer super-secret");
    expect(out).not.toContain("ghp_xxx");
    expect(out).toContain("<redacted>");
    expect(out).toContain("X-Trace: ok");
    expect(out).toContain("DEBUG=1");
  });

  it("import merges entries from a file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-mcp-import-"));
    const file = path.join(dir, "mcp.yaml");
    fs.writeFileSync(file, `linear:\n  type: http\n  url: https://mcp.linear.app/sse\n`);
    const session = new Session();
    const out = stripAnsi(cmdMcp(session, "import", file));
    expect(out).toContain("Added:");
    expect(out).toContain("linear");
    expect(session.config.mcp_servers!.linear).toEqual({ type: "http", url: "https://mcp.linear.app/sse" });
  });

  it("import reports file not found", () => {
    const out = stripAnsi(cmdMcp(new Session(), "import", "/nonexistent/path.yaml"));
    expect(out).toContain("File not found");
  });

  it("remove returns not found for missing name", () => {
    const out = stripAnsi(cmdMcp(new Session(), "remove", "missing"));
    expect(out).toContain("MCP server not found");
  });

  it("remove deletes an existing entry", () => {
    const session = new Session();
    session.setMcpServer("linear", { type: "http", url: "https://mcp.linear.app/sse" });
    const out = stripAnsi(cmdMcp(session, "remove", "linear"));
    expect(out).toContain("MCP server removed");
    expect(session.config.mcp_servers!.linear).toBeUndefined();
  });

  it("clear wipes all entries", () => {
    const session = new Session();
    session.setMcpServer("a", { type: "http", url: "https://x" });
    const out = stripAnsi(cmdMcp(session, "clear"));
    expect(out).toContain("All MCP servers removed");
    expect(session.config.mcp_servers).toEqual({});
  });

  it("rejects unknown subcommand", () => {
    const out = stripAnsi(cmdMcp(new Session(), "bogus"));
    expect(out).toContain("Unknown /mcp subcommand");
  });
});

describe("isMcpInteractiveInvocation", () => {
  it("true for bare /mcp with no args", () => {
    expect(isMcpInteractiveInvocation("mcp", [])).toBe(true);
  });

  it("true for /mcp add (any case)", () => {
    expect(isMcpInteractiveInvocation("mcp", ["add"])).toBe(true);
    expect(isMcpInteractiveInvocation("mcp", ["ADD"])).toBe(true);
  });

  it("false for /mcp list|import|remove|clear so they still route to cmdMcp", () => {
    expect(isMcpInteractiveInvocation("mcp", ["list"])).toBe(false);
    expect(isMcpInteractiveInvocation("mcp", ["import", "/tmp/x"])).toBe(false);
    expect(isMcpInteractiveInvocation("mcp", ["remove", "x"])).toBe(false);
    expect(isMcpInteractiveInvocation("mcp", ["clear"])).toBe(false);
  });

  it("false for non-mcp commands", () => {
    expect(isMcpInteractiveInvocation("model", [])).toBe(false);
    expect(isMcpInteractiveInvocation("repo", ["add"])).toBe(false);
  });
});
