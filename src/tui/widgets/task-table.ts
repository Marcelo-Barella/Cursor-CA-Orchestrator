import blessed from "blessed";
import type { OrchestratorConfig } from "../../config/types.js";
import type { OrchestrationState } from "../../state.js";

function formatDurationMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function timeCell(
  startedAt: string | null,
  finishedAt: string | null,
  nowMs: number,
): string {
  if (startedAt === null) return "--";
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return "--";
  const end = finishedAt !== null ? Date.parse(finishedAt) : nowMs;
  if (finishedAt !== null && Number.isNaN(end)) return "--";
  const ms = Math.max(0, end - start);
  return formatDurationMs(ms);
}

function statusTagged(status: string): string {
  const key = status.toLowerCase();
  const open = (tag: string) => `{${tag}}${status}{/${tag}}`;
  if (key === "finished" || key === "completed") return open("green-fg");
  if (key === "running") return open("yellow-fg");
  if (key === "pending") return open("blue-fg");
  if (key === "failed") return open("red-fg");
  if (key === "blocked") return open("magenta-fg");
  if (key === "launching") return open("cyan-fg");
  if (key === "stopped") return open("gray-fg");
  return status;
}

export function createTaskTable(screen: blessed.Widgets.Screen): blessed.Widgets.ListTableElement {
  return blessed.listtable({
    parent: screen,
    top: 3,
    left: 0,
    width: "60%",
    height: "100%-4",
    keys: true,
    vi: true,
    tags: true,
    border: "line",
    noCellBorders: true,
    style: {
      header: { fg: "white", bold: true },
    },
  }) as blessed.Widgets.ListTableElement;
}

export function updateTaskTable(
  table: blessed.Widgets.ListTableElement,
  state: OrchestrationState,
  config: OrchestratorConfig,
): void {
  const taskById = new Map(config.tasks.map((t) => [t.id, t]));
  const ids = Object.keys(state.agents).sort((a, b) => a.localeCompare(b));
  if (ids.length === 0) {
    table.setData([["Waiting for tasks..."]]);
    return;
  }
  const nowMs = Date.now();
  const header: string[] = ["Task", "Repo", "Status", "Time", "PR"];
  const rows: string[][] = [header];
  for (const id of ids) {
    const agent = state.agents[id];
    if (!agent) continue;
    const task = taskById.get(agent.task_id);
    const repo = task?.repo ?? "--";
    rows.push([
      agent.task_id,
      repo,
      statusTagged(agent.status),
      timeCell(agent.started_at, agent.finished_at, nowMs),
      agent.pr_url ?? "--",
    ]);
  }
  table.setData(rows);
}
