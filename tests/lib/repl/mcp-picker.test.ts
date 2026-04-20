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
});
