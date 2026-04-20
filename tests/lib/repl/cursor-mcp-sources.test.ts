import { describe, expect, it } from "vitest";
import {
  discoverCursorMcpSources,
  type CursorMcpRow,
} from "../../../src/lib/repl/cursor-mcp-sources.js";

type FileMap = Record<string, string>;

function makeReadFile(files: FileMap): (p: string) => Promise<string> {
  return async (p: string) => {
    if (p in files) return files[p]!;
    const err: NodeJS.ErrnoException = new Error(`ENOENT: ${p}`);
    err.code = "ENOENT";
    throw err;
  };
}

describe("discoverCursorMcpSources", () => {
  it("returns [] and no warnings when no files exist", async () => {
    const r = await discoverCursorMcpSources({
      homedir: () => "/home/u",
      cwd: () => "/work",
      readFile: makeReadFile({}),
    });
    expect(r.rows).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("reads global-only wrapped shape into [global] rows", async () => {
    const r = await discoverCursorMcpSources({
      homedir: () => "/home/u",
      cwd: () => "/work",
      readFile: makeReadFile({
        "/home/u/.cursor/mcp.json": JSON.stringify({
          mcpServers: { linear: { type: "http", url: "https://a" } },
        }),
      }),
    });
    expect(r.rows.map((row: CursorMcpRow) => [row.name, row.source])).toEqual([["linear", "global"]]);
    expect(r.warnings).toEqual([]);
  });

  it("reads workspace-only bare map into [workspace] rows", async () => {
    const r = await discoverCursorMcpSources({
      homedir: () => "/home/u",
      cwd: () => "/work",
      readFile: makeReadFile({
        "/work/.cursor/mcp.json": JSON.stringify({ gh: { type: "stdio", command: "npx" } }),
      }),
    });
    expect(r.rows).toEqual([
      { name: "gh", source: "workspace", config: { type: "stdio", command: "npx" } },
    ]);
  });

  it("merges global then workspace, keeping duplicates as distinct rows", async () => {
    const r = await discoverCursorMcpSources({
      homedir: () => "/home/u",
      cwd: () => "/work",
      readFile: makeReadFile({
        "/home/u/.cursor/mcp.json": JSON.stringify({ mcpServers: { x: { type: "http", url: "https://g" } } }),
        "/work/.cursor/mcp.json": JSON.stringify({ mcpServers: { x: { type: "http", url: "https://w" } } }),
      }),
    });
    expect(r.rows.map((row) => [row.name, row.source])).toEqual([
      ["x", "global"],
      ["x", "workspace"],
    ]);
  });

  it("emits Skipping warning for malformed JSON and continues", async () => {
    const r = await discoverCursorMcpSources({
      homedir: () => "/home/u",
      cwd: () => "/work",
      readFile: makeReadFile({
        "/home/u/.cursor/mcp.json": "{ not json",
        "/work/.cursor/mcp.json": JSON.stringify({ a: { type: "http", url: "https://a" } }),
      }),
    });
    expect(r.rows.map((row) => row.name)).toEqual(["a"]);
    expect(r.warnings.join("\n")).toContain("Skipping /home/u/.cursor/mcp.json:");
  });

  it("emits Skipping <name> warning for entries that fail validation", async () => {
    const r = await discoverCursorMcpSources({
      homedir: () => "/home/u",
      cwd: () => "/work",
      readFile: makeReadFile({
        "/home/u/.cursor/mcp.json": JSON.stringify({
          ok: { type: "http", url: "https://a" },
          bad: { type: "stdio", command: "" },
        }),
      }),
    });
    expect(r.rows.map((row) => row.name)).toEqual(["ok"]);
    expect(r.warnings.join("\n")).toContain("Skipping bad in /home/u/.cursor/mcp.json:");
  });
});
