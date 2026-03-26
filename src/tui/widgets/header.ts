import blessed from "blessed";
import type { OrchestratorConfig } from "../../config/types.js";
import type { OrchestrationState } from "../../state.js";

const STATUS_COLORS: Record<string, string> = {
  finished: "{green-fg}",
  running: "{yellow-fg}",
  pending: "{blue-fg}",
  failed: "{red-fg}",
  blocked: "{magenta-fg}",
  launching: "{cyan-fg}",
  stopped: "{gray-fg}",
  completed: "{green-fg}",
};

function formatElapsed(startedAt: string | null): string {
  if (!startedAt) return "--";
  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) return "--";
  const total = Math.max(0, Math.floor((Date.now() - start.getTime()) / 1000));
  const h = Math.floor(total / 3600);
  const rem = total % 3600;
  const m = Math.floor(rem / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  const totalM = Math.floor(total / 60);
  const sec = total % 60;
  if (totalM > 0) return `${totalM}m ${String(sec).padStart(2, "0")}s`;
  return `${total}s`;
}

function paintStatus(status: string): string {
  const tag = STATUS_COLORS[status];
  if (!tag) return status;
  return `${tag}${status}{/}`;
}

export function createHeader(screen: blessed.Widgets.Screen): blessed.Widgets.BoxElement {
  return blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    border: "line",
    tags: true,
  }) as blessed.Widgets.BoxElement;
}

export function updateHeader(
  box: blessed.Widgets.BoxElement,
  state: OrchestrationState,
  config: OrchestratorConfig,
): void {
  const finished = Object.values(state.agents).filter((a) => a.status === "finished").length;
  const total = Object.keys(state.agents).length;
  const tasksLabel =
    total === 0 && config.prompt ? "{gray-fg}[planning...]{/}" : `{gray-fg}[${finished}/${total} tasks]{/}`;
  const title = `{bold}cursor-orch: ${config.name}{/bold}`;
  const elapsed = formatElapsed(state.started_at);
  const line = `${title}  ${tasksLabel}  {gray-fg}status:{/} ${paintStatus(state.status)}  {gray-fg}elapsed: ${elapsed}{/}`;
  box.setContent(line);
}
