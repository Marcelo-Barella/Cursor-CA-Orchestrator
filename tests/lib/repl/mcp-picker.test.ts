import { describe, expect, it, vi } from "vitest";
import { parseMcpServers } from "../../../src/config/parse.js";
import type { McpServerConfig } from "../../../src/config/types.js";
import { validateMcpServers } from "../../../src/config/validate.js";
import type { CursorMcpRow } from "../../../src/lib/repl/cursor-mcp-sources.js";
import type { PickOptions, PickResult } from "../../../src/lib/repl/list-picker.js";
import {
  runMcpAdd,
  type McpPickerDeps,
  type McpPickFn,
} from "../../../src/lib/repl/pickers/mcp-picker.js";

type PickFn = <T>(items: T[], opts: PickOptions<T>) => Promise<PickResult<T>>;

function makeDeps(overrides: Partial<McpPickerDeps> = {}): {
  deps: McpPickerDeps;
  logs: string[];
  imports: Record<string, McpServerConfig>[];
} {
  const logs: string[] = [];
  const imports: Record<string, McpServerConfig>[] = [];
  const pickStub: PickFn = async () => ({ kind: "cancelled" });
  const deps: McpPickerDeps = {
    pick: pickStub,
    readLine: async () => null,
    writeLine: (s) => logs.push(s),
    listCursorSources: async () => ({ rows: [], warnings: [] }),
    importMap: (map) => {
      const parsed = parseMcpServers(map);
      validateMcpServers(parsed);
      imports.push(map);
      return { added: Object.keys(map), replaced: [] };
    },
    existingNames: new Set<string>(),
    isTTY: true,
    ...overrides,
  };
  return { deps, logs, imports };
}

describe("runMcpAdd source picker", () => {
  it("cancels silently when source picker is cancelled", async () => {
    const { deps, imports, logs } = makeDeps();
    await runMcpAdd(deps);
    expect(imports).toEqual([]);
    expect(logs.some((l) => l.includes("Cancelled"))).toBe(true);
  });

  it("routes Paste JSON selection to paste flow", async () => {
    const picks: PickFn = vi.fn(async (items, _opts) => ({
      kind: "selected" as const,
      value: items[0]!,
    }));
    const { deps, imports } = makeDeps({
      pick: picks,
      readLine: async () => `{"a":{"type":"http","url":"https://a"}}`,
    });
    await runMcpAdd(deps);
    expect(imports).toEqual([{ a: { type: "http", url: "https://a" } }]);
  });

  it("routes Pick from Cursor selection to cursor-pick flow", async () => {
    const row: CursorMcpRow = {
      name: "linear",
      source: "global",
      config: { type: "http", url: "https://mcp.linear.app/sse" },
    };
    let callIdx = 0;
    const picks: PickFn = async (items, _opts) => {
      callIdx++;
      if (callIdx === 1) {
        return { kind: "selected", value: items[1]! };
      }
      return { kind: "selected", values: items };
    };
    const { deps, imports } = makeDeps({
      pick: picks,
      listCursorSources: async () => ({ rows: [row], warnings: [] }),
    });
    await runMcpAdd(deps);
    expect(imports).toEqual([{ linear: row.config }]);
  });
});

describe("runPasteJsonFlow", () => {
  function pickPaste(): McpPickFn {
    return async (items, _opts) => ({ kind: "selected", value: items[0]! });
  }

  it("wrapped shape with mcpServers key imports all entries", async () => {
    const { deps, imports } = makeDeps({
      pick: pickPaste(),
      readLine: async () =>
        JSON.stringify({
          mcpServers: {
            a: { type: "http", url: "https://a" },
            b: { type: "stdio", command: "npx" },
          },
        }),
    });
    await runMcpAdd(deps);
    expect(imports).toEqual([
      {
        a: { type: "http", url: "https://a" },
        b: { type: "stdio", command: "npx" },
      },
    ]);
  });

  it("bare name-keyed map imports all entries", async () => {
    const { deps, imports } = makeDeps({
      pick: pickPaste(),
      readLine: async () =>
        JSON.stringify({
          a: { type: "http", url: "https://a" },
        }),
    });
    await runMcpAdd(deps);
    expect(imports).toEqual([{ a: { type: "http", url: "https://a" } }]);
  });

  it("invalid JSON prints error and does not mutate", async () => {
    const { deps, imports, logs } = makeDeps({
      pick: pickPaste(),
      readLine: async () => "{ not json",
    });
    await runMcpAdd(deps);
    expect(imports).toEqual([]);
    expect(logs.join("\n")).toContain("Invalid JSON");
  });

  it("blank submission cancels cleanly", async () => {
    const { deps, imports, logs } = makeDeps({
      pick: pickPaste(),
      readLine: async () => "   ",
    });
    await runMcpAdd(deps);
    expect(imports).toEqual([]);
    expect(logs.join("\n")).toContain("Cancelled");
  });

  it("validation error prints message and does not mutate", async () => {
    const { deps, imports, logs } = makeDeps({
      pick: pickPaste(),
      readLine: async () => JSON.stringify({ a: { type: "stdio", command: "" } }),
    });
    await runMcpAdd(deps);
    expect(imports).toEqual([]);
    expect(logs.join("\n")).toContain("Validation failed");
  });

  it("unrecognized shape (array) prints dedicated error", async () => {
    const { deps, imports, logs } = makeDeps({
      pick: pickPaste(),
      readLine: async () => JSON.stringify([1, 2, 3]),
    });
    await runMcpAdd(deps);
    expect(imports).toEqual([]);
    expect(logs.join("\n")).toContain("Unrecognized MCP shape");
  });

  function makeReader(answers: Array<string | null>): (prompt: string) => Promise<string | null> {
    let i = 0;
    return async () => {
      const v = i < answers.length ? answers[i] : null;
      i++;
      return v ?? null;
    };
  }

  it("single server body prompts for name and imports under that name", async () => {
    const { deps, imports } = makeDeps({
      pick: async (items, _opts) => ({ kind: "selected", value: items[0]! }),
      readLine: makeReader([
        JSON.stringify({ type: "http", url: "https://a" }),
        "linear",
      ]),
    });
    await runMcpAdd(deps);
    expect(imports).toEqual([{ linear: { type: "http", url: "https://a" } }]);
  });

  it("single body with colliding name re-prompts until unique", async () => {
    const { deps, imports, logs } = makeDeps({
      pick: async (items, _opts) => ({ kind: "selected", value: items[0]! }),
      existingNames: new Set(["linear"]),
      readLine: makeReader([
        JSON.stringify({ type: "http", url: "https://a" }),
        "linear",
        "linear-2",
      ]),
    });
    await runMcpAdd(deps);
    expect(imports).toEqual([{ "linear-2": { type: "http", url: "https://a" } }]);
    expect(logs.join("\n")).toContain('Name "linear" already exists');
  });

  it("single body with blank name cancels", async () => {
    const { deps, imports, logs } = makeDeps({
      pick: async (items, _opts) => ({ kind: "selected", value: items[0]! }),
      readLine: makeReader([
        JSON.stringify({ type: "http", url: "https://a" }),
        "   ",
      ]),
    });
    await runMcpAdd(deps);
    expect(imports).toEqual([]);
    expect(logs.join("\n")).toContain("Cancelled");
  });
});

describe("runCursorPickFlow", () => {
  function pickCursor(): McpPickFn {
    let call = 0;
    return async (items, _opts) => {
      call++;
      if (call === 1) {
        const idx = items.findIndex(
          (it: unknown) => (it as { label?: string }).label === "Pick from Cursor config",
        );
        return { kind: "selected", value: items[idx]! };
      }
      return { kind: "selected", values: items };
    };
  }

  const GLOBAL_ROW: CursorMcpRow = {
    name: "linear",
    source: "global",
    config: { type: "http", url: "https://g" },
  };
  const WORKSPACE_ROW: CursorMcpRow = {
    name: "gh",
    source: "workspace",
    config: { type: "stdio", command: "npx" },
  };

  it("prints dim empty message and skips picker when no rows", async () => {
    const { deps, imports, logs } = makeDeps({
      pick: pickCursor(),
      listCursorSources: async () => ({ rows: [], warnings: [] }),
    });
    await runMcpAdd(deps);
    expect(imports).toEqual([]);
    expect(logs.join("\n")).toContain("No MCP servers found in ~/.cursor/mcp.json");
  });

  it("prints warnings from discovery", async () => {
    const { deps, logs } = makeDeps({
      pick: pickCursor(),
      listCursorSources: async () => ({
        rows: [GLOBAL_ROW],
        warnings: ["Skipping /path: bad json"],
      }),
    });
    await runMcpAdd(deps);
    expect(logs.join("\n")).toContain("Skipping /path: bad json");
  });

  it("multi-select confirm calls importMap once with union of selected configs", async () => {
    const { deps, imports } = makeDeps({
      pick: pickCursor(),
      listCursorSources: async () => ({
        rows: [GLOBAL_ROW, WORKSPACE_ROW],
        warnings: [],
      }),
    });
    await runMcpAdd(deps);
    expect(imports).toEqual([
      { linear: GLOBAL_ROW.config, gh: WORKSPACE_ROW.config },
    ]);
  });

  it("duplicate names across sources: later row (workspace) overrides", async () => {
    const dupGlobal: CursorMcpRow = {
      name: "x",
      source: "global",
      config: { type: "http", url: "https://g" },
    };
    const dupWorkspace: CursorMcpRow = {
      name: "x",
      source: "workspace",
      config: { type: "http", url: "https://w" },
    };
    const { deps, imports } = makeDeps({
      pick: pickCursor(),
      listCursorSources: async () => ({
        rows: [dupGlobal, dupWorkspace],
        warnings: [],
      }),
    });
    await runMcpAdd(deps);
    expect(imports).toEqual([{ x: dupWorkspace.config }]);
  });

  it("zero selection cancels without mutation", async () => {
    let call = 0;
    const pick: McpPickFn = async (items, opts) => {
      call++;
      if (call === 1) {
        const idx = items.findIndex(
          (it: unknown) => (it as { label?: string }).label === "Pick from Cursor config",
        );
        return { kind: "selected", value: items[idx]! };
      }
      expect(opts.multiSelect).toBe(true);
      return { kind: "cancelled" };
    };
    const { deps, imports, logs } = makeDeps({
      pick,
      listCursorSources: async () => ({ rows: [GLOBAL_ROW], warnings: [] }),
    });
    await runMcpAdd(deps);
    expect(imports).toEqual([]);
    expect(logs.join("\n")).toContain("Cancelled");
  });
});
