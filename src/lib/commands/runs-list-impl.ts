import YAML from "yaml";
import type { RepoStoreClient } from "../../api/repo-store.js";
import { deserialize } from "../../state.js";

export const DEFAULT_RUN_LIST_CONCURRENCY = 5;

export type RunListRow = {
  runId: string;
  name: string;
  status: string;
  started_at: string | null;
  taskCount: number;
};

export function parseNameFromConfigYaml(yamlStr: string): string {
  try {
    const raw = YAML.parse(yamlStr) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw) && "name" in raw) {
      const n = (raw as { name?: unknown }).name;
      if (typeof n === "string") {
        const t = n.trim();
        if (t.length) return t;
      }
    }
  } catch {
    return "";
  }
  return "";
}

export function parseRunBranchToId(branch: string): string | null {
  const ref = branch.replace(/^refs\/heads\//, "");
  if (!ref.startsWith("run/")) {
    return null;
  }
  const runId = ref.slice("run/".length).trim();
  return runId.length ? runId : null;
}

function startedRank(iso: string | null): { ok: boolean; t: number } {
  if (iso === null || !iso.trim()) {
    return { ok: false, t: 0 };
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return { ok: false, t: 0 };
  }
  return { ok: true, t: ms };
}

export function sortRunsNewestStartedFirst(rows: RunListRow[]): RunListRow[] {
  return [...rows].sort((a, b) => {
    const ra = startedRank(a.started_at);
    const rb = startedRank(b.started_at);
    if (ra.ok && rb.ok) {
      return rb.t - ra.t;
    }
    if (ra.ok && !rb.ok) {
      return -1;
    }
    if (!ra.ok && rb.ok) {
      return 1;
    }
    return 0;
  });
}

export function applyRunLimit(rows: RunListRow[], limit: number): RunListRow[] {
  return rows.slice(0, Math.max(0, limit));
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = idx++;
      if (i >= items.length) {
        return;
      }
      results[i] = await fn(items[i]!);
    }
  }

  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export async function collectRunRows(
  client: Pick<RepoStoreClient, "listRunBranches" | "readFile">,
  concurrency = DEFAULT_RUN_LIST_CONCURRENCY,
): Promise<RunListRow[]> {
  const branches = await client.listRunBranches();
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const b of branches) {
    const runId = parseRunBranchToId(b);
    if (!runId || seen.has(runId)) {
      continue;
    }
    seen.add(runId);
    ids.push(runId);
  }

  const rowOrNull = await mapPool(ids, concurrency, async (runId) => {
    try {
      const content = await client.readFile(runId, "state.json");
      if (!content) {
        return null;
      }
      const state = deserialize(content);
      let name = "";
      try {
        const cfgYaml = await client.readFile(runId, "config.yaml");
        if (cfgYaml) {
          name = parseNameFromConfigYaml(cfgYaml);
        }
      } catch {
        name = "";
      }
      return {
        runId,
        name,
        status: state.status,
        started_at: state.started_at,
        taskCount: Object.keys(state.agents).length,
      } satisfies RunListRow;
    } catch {
      return null;
    }
  });

  return rowOrNull.filter((r): r is RunListRow => r !== null);
}

export function formatRunsTable(rows: RunListRow[]): string {
  if (!rows.length) {
    return "No runs to display (none found or all branches skipped unreadable state).";
  }
  const header = ["run_id", "name", "status", "started_at", "tasks"];
  const colW = rows.reduce(
    (acc, row) => {
      const dispName = row.name.trim() || "—";
      acc.run = Math.max(acc.run, row.runId.length);
      acc.name = Math.max(acc.name, dispName.length);
      acc.status = Math.max(acc.status, row.status.length);
      acc.started = Math.max(acc.started, (row.started_at ?? "").length);
      return acc;
    },
    {
      run: header[0]!.length,
      name: header[1]!.length,
      status: header[2]!.length,
      started: header[3]!.length,
      tasks: header[4]!.length,
    },
  );

  function pad(cell: string, w: number): string {
    return cell.length >= w ? cell : `${cell}${" ".repeat(w - cell.length)}`;
  }

  const sep = `-`.repeat(colW.run + colW.name + colW.status + colW.started + colW.tasks + 16);
  const lines = [
    `${pad(header[0]!, colW.run)}   ${pad(header[1]!, colW.name)}   ${pad(header[2]!, colW.status)}   ${pad(header[3]!, colW.started)}   ${header[4]}`,
    sep,
    ...rows.map((r) => {
      const sa = r.started_at ?? "";
      const dispName = r.name.trim() ? r.name : "—";
      return `${pad(r.runId, colW.run)}   ${pad(dispName, colW.name)}   ${pad(r.status, colW.status)}   ${pad(sa, colW.started)}   ${String(r.taskCount)}`;
    }),
  ];
  return lines.join("\n");
}

export async function printRunsList(
  client: Pick<RepoStoreClient, "listRunBranches" | "readFile">,
  limit: number,
): Promise<void> {
  const rows = sortRunsNewestStartedFirst(await collectRunRows(client));
  const slice = applyRunLimit(rows, limit);
  console.log(formatRunsTable(slice));
}
