import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSessionPaths, Session } from "../src/session.js";

describe("Session", () => {
  it("resetSessionToDefaults clears all config and setup state", () => {
    const session = new Session();
    session.setName("n");
    session.setModel("m");
    session.setPrompt("p");
    session.setBranchPrefix("other");
    session.setAutoPr(false);
    session.addRepo("a", "https://example.com/a.git");
    session.setBootstrapRepo("custom-bootstrap");
    session.setSetupState({ active: true, step: "prompt" });
    session.config.tasks.push({
      id: "t1",
      repo: "a",
      prompt: "x",
      model: null,
      depends_on: [],
      timeout_minutes: 30,
      create_repo: false,
      repo_config: null,
    });

    session.resetSessionToDefaults();

    const fresh = new Session();
    expect(session.config).toEqual(fresh.config);
    expect(session.setupState()).toEqual(fresh.setupState());
  });
});

describe("session storage isolation", () => {
  it("namespaces session files by workspace path", () => {
    const alpha = resolveSessionPaths({
      homeDir: "/home/dev",
      cwd: "/workspaces/alpha",
    });
    const beta = resolveSessionPaths({
      homeDir: "/home/dev",
      cwd: "/workspaces/beta",
    });

    expect(alpha.sessionPath).not.toBe(beta.sessionPath);
    expect(alpha.setupStatePath).not.toBe(beta.setupStatePath);
    expect(alpha.historyPath).not.toBe(beta.historyPath);
  });

  it("uses the explicit session key across workspaces", () => {
    const left = resolveSessionPaths({
      homeDir: "/home/dev",
      cwd: "/workspaces/alpha",
      sessionKey: "shared",
    });
    const right = resolveSessionPaths({
      homeDir: "/home/dev",
      cwd: "/workspaces/beta",
      sessionKey: "shared",
    });

    expect(left.sessionPath).toBe(right.sessionPath);
    expect(left.historyPath).toBe(right.historyPath);
  });
});

describe("Session MCP servers", () => {
  it("setMcpServer adds entries and validates", () => {
    const session = new Session();
    session.setMcpServer("linear", { type: "http", url: "https://mcp.linear.app/sse" });
    expect(session.config.mcp_servers?.linear).toEqual({ type: "http", url: "https://mcp.linear.app/sse" });
    expect(() => session.setMcpServer("bad name", { type: "http", url: "https://x" })).toThrow();
  });

  it("removeMcpServer returns false when missing", () => {
    const session = new Session();
    expect(session.removeMcpServer("none")).toBe(false);
    session.setMcpServer("a", { type: "http", url: "https://x" });
    expect(session.removeMcpServer("a")).toBe(true);
    expect(session.config.mcp_servers?.a).toBeUndefined();
  });

  it("clearMcpServers wipes the map", () => {
    const session = new Session();
    session.setMcpServer("a", { type: "http", url: "https://x" });
    session.clearMcpServers();
    expect(session.config.mcp_servers).toEqual({});
  });

  it("importMcpServersFromFile merges with bare top-level mapping", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-import-"));
    const file = path.join(dir, "mcp.yaml");
    fs.writeFileSync(
      file,
      `linear:\n  type: http\n  url: https://mcp.linear.app/sse\ngh:\n  type: stdio\n  command: npx\n  args: ["-y", "@modelcontextprotocol/server-github"]\n`,
    );
    const session = new Session();
    session.setMcpServer("linear", { type: "http", url: "https://old" });
    const result = session.importMcpServersFromFile(file);
    expect(result.added).toEqual(["gh"]);
    expect(result.replaced).toEqual(["linear"]);
    expect(session.config.mcp_servers!.linear).toEqual({ type: "http", url: "https://mcp.linear.app/sse" });
    expect(session.config.mcp_servers!.gh).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
  });

  it("importMcpServersFromFile accepts mcp_servers wrapper", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-import-wrapped-"));
    const file = path.join(dir, "mcp.yaml");
    fs.writeFileSync(file, `mcp_servers:\n  linear:\n    type: http\n    url: https://mcp.linear.app/sse\n`);
    const session = new Session();
    const result = session.importMcpServersFromFile(file);
    expect(result.added).toEqual(["linear"]);
    expect(session.config.mcp_servers!.linear).toEqual({ type: "http", url: "https://mcp.linear.app/sse" });
  });
});

describe("importMcpServersFromMap", () => {
  it("validates, merges, and reports added + replaced", () => {
    const session = new Session();
    session.setMcpServer("linear", { type: "http", url: "https://old" });
    const result = session.importMcpServersFromMap({
      linear: { type: "http", url: "https://new" },
      github: { type: "stdio", command: "npx" },
    });
    expect(result.added.sort()).toEqual(["github"]);
    expect(result.replaced).toEqual(["linear"]);
    expect(session.config.mcp_servers).toEqual({
      linear: { type: "http", url: "https://new" },
      github: { type: "stdio", command: "npx" },
    });
  });

  it("throws on validation failure and does not mutate", () => {
    const session = new Session();
    session.setMcpServer("keep", { type: "http", url: "https://x" });
    expect(() =>
      session.importMcpServersFromMap({ bad: { type: "stdio", command: "" } } as never),
    ).toThrow();
    expect(session.config.mcp_servers).toEqual({ keep: { type: "http", url: "https://x" } });
  });

  it("importMcpServersFromFile delegates and preserves behavior", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-import-"));
    const file = path.join(dir, "mcp.yaml");
    fs.writeFileSync(file, `mcpServers:\n  a:\n    type: http\n    url: https://a\n`);
    const session = new Session();
    const res = session.importMcpServersFromFile(file);
    expect(res.added).toEqual(["a"]);
    expect(session.config.mcp_servers).toEqual({ a: { type: "http", url: "https://a" } });
  });
});
