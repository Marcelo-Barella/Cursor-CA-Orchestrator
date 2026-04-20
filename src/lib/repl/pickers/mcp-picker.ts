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

export async function runPasteJsonFlow(_deps: McpPickerDeps): Promise<void> {
  throw new Error("not implemented");
}

export async function runCursorPickFlow(_deps: McpPickerDeps): Promise<void> {
  throw new Error("not implemented");
}
