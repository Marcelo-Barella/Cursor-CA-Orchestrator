import chalk from "chalk";
import { setTimeout as delay } from "node:timers/promises";
import type { RepoStoreClient } from "./api/repo-store.js";
import type { OrchestratorConfig } from "./config/types.js";
import { type OrchestrationEvent, type OrchestrationState, deserialize, readEvents } from "./state.js";

const POLL_INTERVAL = 10;
const TERMINAL_STATES = new Set(["completed", "failed", "stopped"]);

const STATUS_COLORS: Record<string, (s: string) => string> = {
  finished: chalk.green,
  running: chalk.yellow,
  pending: chalk.blue,
  failed: chalk.red,
  blocked: chalk.magenta,
  launching: chalk.cyan,
  stopped: chalk.dim,
  completed: chalk.green,
};

function elapsedStr(startedAt: string | null): string {
  if (!startedAt) return "--";
  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) return "--";
  const total = Math.max(0, Math.floor((Date.now() - start.getTime()) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h > 0) return `${h}h${String(mm).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function durationStr(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return "--";
  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) return "--";
  const end = finishedAt ? new Date(finishedAt) : new Date();
  const total = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function paintStatus(status: string): (s: string) => string {
  return STATUS_COLORS[status] ?? ((x: string) => x);
}

function buildHeader(state: OrchestrationState, config: OrchestratorConfig): string {
  const finished = Object.values(state.agents).filter((a) => a.status === "finished").length;
  const total = Object.keys(state.agents).length;
  const color = paintStatus(state.status);
  const tasksLabel = total === 0 && config.prompt ? "[planning...]" : `[${finished}/${total} tasks]`;
  return `${chalk.bold(`cursor-orch: ${config.name}`)}  ${chalk.dim(tasksLabel)}  ${chalk.dim("status:")} ${color(state.status)}  ${chalk.dim(`elapsed: ${elapsedStr(state.started_at)}`)}`;
}

function buildTable(state: OrchestrationState, config: OrchestratorConfig): string {
  const taskMap = Object.fromEntries(config.tasks.map((t) => [t.id, t]));
  const rows: string[] = ["Task | Repo | Status | Time | PR", "-----|------|--------|------|-----"];
  for (const [taskId, agent] of Object.entries(state.agents)) {
    const task = taskMap[taskId];
    const repo = task ? task.repo : "?";
    const st = paintStatus(agent.status)(agent.status.toUpperCase());
    rows.push(`${taskId} | ${repo} | ${st} | ${durationStr(agent.started_at, agent.finished_at)} | ${agent.pr_url ?? "--"}`);
  }
  return rows.join("\n");
}

function formatEvent(ev: OrchestrationEvent): string {
  let ts = ev.timestamp;
  try {
    ts = new Date(ev.timestamp).toISOString().slice(11, 19);
  } catch {
    /* keep */
  }
  return `[${ts}] ${ev.detail}`;
}

export async function renderSnapshot(state: OrchestrationState, config: OrchestratorConfig, events: OrchestrationEvent[]): Promise<void> {
  console.log();
  console.log(buildHeader(state, config));
  console.log();
  console.log(buildTable(state, config));
  console.log();
  console.log(chalk.dim("Events:"));
  const recent = events.slice(-10);
  if (!recent.length) {
    console.log(chalk.dim("No events yet."));
  } else {
    for (const ev of recent) {
      console.log(formatEvent(ev));
    }
  }
  console.log();
}

async function pollOnce(
  repoStore: RepoStoreClient,
  runId: string,
  _config: OrchestratorConfig,
): Promise<{ state: OrchestrationState; events: OrchestrationEvent[]; terminal: boolean }> {
  const content = await repoStore.readFile(runId, "state.json");
  const state = deserialize(content);
  const events = await readEvents(repoStore, runId);
  return { state, events, terminal: TERMINAL_STATES.has(state.status) };
}

export async function renderLive(repoStore: RepoStoreClient, runId: string, config: OrchestratorConfig): Promise<void> {
  while (true) {
    const { state, events, terminal } = await pollOnce(repoStore, runId, config);
    console.clear();
    await renderSnapshot(state, config, events);
    if (terminal) {
      await delay(2000);
      break;
    }
    await delay(POLL_INTERVAL * 1000);
  }
}
