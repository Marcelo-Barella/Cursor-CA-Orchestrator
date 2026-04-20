import * as path from "node:path";
import type { McpServerConfig } from "../../config/types.js";
import { parseMcpServers } from "../../config/parse.js";
import { validateMcpServers } from "../../config/validate.js";

export type CursorMcpSource = "global" | "workspace";

export interface CursorMcpRow {
  name: string;
  source: CursorMcpSource;
  config: McpServerConfig;
}

export interface DiscoverDeps {
  homedir: () => string;
  cwd: () => string;
  readFile: (filePath: string) => Promise<string>;
}

export interface DiscoverResult {
  rows: CursorMcpRow[];
  warnings: string[];
}

function extractServers(raw: unknown): unknown {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if ("mcpServers" in o && o.mcpServers !== undefined) return o.mcpServers;
  if ("mcp_servers" in o && o.mcp_servers !== undefined) return o.mcp_servers;
  return o;
}

async function readOne(
  filePath: string,
  source: CursorMcpSource,
  deps: DiscoverDeps,
  rows: CursorMcpRow[],
  warnings: string[],
): Promise<void> {
  let text: string;
  try {
    text = await deps.readFile(filePath);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return;
    warnings.push(`Skipping ${filePath}: ${err.message}`);
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    warnings.push(`Skipping ${filePath}: ${(e as Error).message}`);
    return;
  }
  const candidate = extractServers(raw);
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    warnings.push(`Skipping ${filePath}: expected an object mapping server names to configs`);
    return;
  }
  for (const [name, entry] of Object.entries(candidate as Record<string, unknown>)) {
    try {
      const parsed = parseMcpServers({ [name]: entry });
      validateMcpServers(parsed);
      rows.push({ name, source, config: parsed[name]! });
    } catch (e) {
      warnings.push(`Skipping ${name} in ${filePath}: ${(e as Error).message}`);
    }
  }
}

export async function discoverCursorMcpSources(deps: DiscoverDeps): Promise<DiscoverResult> {
  const globalPath = path.join(deps.homedir(), ".cursor", "mcp.json");
  const workspacePath = path.join(deps.cwd(), ".cursor", "mcp.json");
  const rows: CursorMcpRow[] = [];
  const warnings: string[] = [];
  await readOne(globalPath, "global", deps, rows, warnings);
  await readOne(workspacePath, "workspace", deps, rows, warnings);
  return { rows, warnings };
}
