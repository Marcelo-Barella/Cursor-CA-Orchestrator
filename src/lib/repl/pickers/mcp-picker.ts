import type { McpServerConfig } from "../../../config/types.js";
import { tui } from "../../../tui/style.js";
import type { PickOptions, PickResult } from "../list-picker.js";
import type { DiscoverResult } from "../cursor-mcp-sources.js";

export type McpPickFn = <T>(items: T[], opts: PickOptions<T>) => Promise<PickResult<T>>;

export interface McpPickerDeps {
  pick: McpPickFn;
  readLine: (prompt: string) => Promise<string | null>;
  writeLine: (line: string) => void;
  listCursorSources: () => Promise<DiscoverResult>;
  importMap: (map: Record<string, McpServerConfig>) => { added: string[]; replaced: string[] };
  existingNames: Set<string>;
  isTTY: boolean;
}

type SourceChoice = "paste" | "cursor";

interface SourceRow {
  id: SourceChoice;
  label: string;
}

const SOURCE_ROWS: SourceRow[] = [
  { id: "paste", label: "Paste JSON" },
  { id: "cursor", label: "Pick from Cursor config" },
];

export async function runMcpAdd(deps: McpPickerDeps): Promise<void> {
  const picked = await deps.pick(SOURCE_ROWS, {
    title: "Add MCP server",
    renderItem: (r) => r.label,
    filterText: (r) => r.label,
    isTTY: deps.isTTY,
  });
  if (picked.kind === "cancelled" || !("value" in picked)) {
    deps.writeLine(tui.dim("Cancelled."));
    return;
  }
  if (picked.value.id === "paste") {
    await runPasteJsonFlow(deps);
    return;
  }
  await runCursorPickFlow(deps);
}

type PasteShape =
  | { kind: "map"; map: Record<string, unknown> }
  | { kind: "single"; body: Record<string, unknown> }
  | { kind: "unrecognized" };

const PASTE_HINT =
  "Paste MCP JSON. Ctrl+J or Alt+Enter for newline, Enter submits. Blank line cancels.";

function tryParseAsEntryFragment(raw: string): unknown | undefined {
  const trimmed = raw.trim().replace(/,\s*$/, "");
  if (!trimmed.startsWith('"')) return undefined;
  try {
    const wrapped = JSON.parse(`{${trimmed}}`);
    if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
      return wrapped;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function detectPasteShape(raw: unknown): PasteShape {
  if (raw === null || raw === undefined) return { kind: "unrecognized" };
  if (typeof raw !== "object" || Array.isArray(raw)) return { kind: "unrecognized" };
  const o = raw as Record<string, unknown>;
  if ("mcpServers" in o && o.mcpServers !== undefined) {
    const inner = o.mcpServers;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return { kind: "map", map: inner as Record<string, unknown> };
    }
    return { kind: "unrecognized" };
  }
  if ("mcp_servers" in o && o.mcp_servers !== undefined) {
    const inner = o.mcp_servers;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return { kind: "map", map: inner as Record<string, unknown> };
    }
    return { kind: "unrecognized" };
  }
  if ("type" in o || "command" in o || "url" in o) {
    return { kind: "single", body: o };
  }
  return { kind: "map", map: o };
}

export async function runPasteJsonFlow(deps: McpPickerDeps): Promise<void> {
  deps.writeLine(tui.dim(PASTE_HINT));
  const raw = await deps.readLine("");
  if (raw === null || raw.trim() === "") {
    deps.writeLine(tui.dim("Cancelled."));
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const wrapped = tryParseAsEntryFragment(raw);
    if (wrapped !== undefined) {
      parsed = wrapped;
    } else {
      deps.writeLine(tui.red(`Invalid JSON: ${(e as Error).message}`));
      return;
    }
  }
  const shape = detectPasteShape(parsed);
  if (shape.kind === "unrecognized") {
    deps.writeLine(
      tui.red(
        'Unrecognized MCP shape. Expected { "mcpServers": {...} }, a name-keyed map, or a single server body.',
      ),
    );
    return;
  }
  if (shape.kind === "single") {
    const name = await promptUniqueName(deps);
    if (name === null) {
      deps.writeLine(tui.dim("Cancelled."));
      return;
    }
    await importAndReport(deps, { [name]: shape.body });
    return;
  }
  await importAndReport(deps, shape.map);
}

async function promptUniqueName(deps: McpPickerDeps): Promise<string | null> {
  let prompt = "Server name: ";
  while (true) {
    const raw = await deps.readLine(prompt);
    if (raw === null) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (!deps.existingNames.has(trimmed)) return trimmed;
    deps.writeLine(
      tui.red(`Name "${trimmed}" already exists. Enter a different name or blank to cancel:`),
    );
    prompt = "Server name: ";
  }
}

async function importAndReport(
  deps: McpPickerDeps,
  map: Record<string, unknown>,
): Promise<void> {
  let result: { added: string[]; replaced: string[] };
  try {
    result = deps.importMap(map as Record<string, McpServerConfig>);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const nameMatch = /^mcp_servers\['([^']+)'\]/.exec(message);
    if (nameMatch) {
      deps.writeLine(tui.red(`Validation failed for "${nameMatch[1]}": ${message}`));
    } else {
      deps.writeLine(tui.red(`Validation failed: ${message}`));
    }
    return;
  }
  if (result.added.length) {
    deps.writeLine(tui.green(`Added: ${result.added.join(", ")}`));
  }
  if (result.replaced.length) {
    deps.writeLine(tui.yellow(`Replaced: ${result.replaced.join(", ")}`));
  }
}

export async function runCursorPickFlow(deps: McpPickerDeps): Promise<void> {
  const discovered = await deps.listCursorSources();
  for (const w of discovered.warnings) {
    deps.writeLine(tui.dim(w));
  }
  if (discovered.rows.length === 0) {
    deps.writeLine(
      tui.dim("No MCP servers found in ~/.cursor/mcp.json or ./.cursor/mcp.json."),
    );
    return;
  }
  const picked = await deps.pick(discovered.rows, {
    title: "Pick MCP servers to add",
    renderItem: (row) =>
      `${row.name}  ${tui.dim(`[${row.source}]`)}  ${tui.dim(`(${row.config.type})`)}`,
    filterText: (row) => `${row.name} ${row.source}`,
    multiSelect: true,
    isTTY: deps.isTTY,
  });
  if (picked.kind === "cancelled" || !("values" in picked) || picked.values.length === 0) {
    deps.writeLine(tui.dim("Cancelled."));
    return;
  }
  const map: Record<string, McpServerConfig> = {};
  for (const row of picked.values) {
    map[row.name] = row.config;
  }
  await importAndReport(deps, map);
}
