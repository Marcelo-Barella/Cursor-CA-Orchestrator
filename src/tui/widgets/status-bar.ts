import blessed from "blessed";
import type { OrchestrationState } from "../../state.js";

const TERMINAL_ORCH_STATUSES = new Set(["completed", "failed", "stopped"]);

export function completionModeStatusText(status: string): string | null {
  const s = status.toLowerCase();
  if (!TERMINAL_ORCH_STATUSES.has(s)) return null;
  if (s === "completed") return "Completed — Press q or Ctrl+C to exit";
  if (s === "failed") return "Failed — Press q or Ctrl+C to exit";
  return "Stopped — Press q or Ctrl+C to exit";
}

function statusTagged(status: string): string {
  const s = status.toLowerCase();
  if (s === "finished" || s === "completed") {
    return `{green-fg}${status}{/}`;
  }
  if (s === "running") {
    return `{yellow-fg}${status}{/}`;
  }
  if (s === "pending") {
    return `{blue-fg}${status}{/}`;
  }
  if (s === "failed") {
    return `{red-fg}${status}{/}`;
  }
  if (s === "blocked") {
    return `{magenta-fg}${status}{/}`;
  }
  if (s === "launching") {
    return `{cyan-fg}${status}{/}`;
  }
  if (s === "stopped") {
    return `{2}${status}{/}`;
  }
  return status;
}

export function createStatusBar(screen: blessed.Widgets.Screen): blessed.Widgets.BoxElement {
  return blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    wrap: true,
    tags: true,
    style: { fg: "white", bg: "blue" },
  });
}

export function updateStatusBar(bar: blessed.Widgets.BoxElement, state: OrchestrationState): void {
  const completion = completionModeStatusText(state.status);
  if (completion !== null) {
    const s = state.status.toLowerCase();
    let tagged: string;
    if (s === "completed") {
      tagged = `{green-fg}Completed{/} — Press q or Ctrl+C to exit`;
    } else if (s === "failed") {
      tagged = `{red-fg}Failed{/} — Press q or Ctrl+C to exit`;
    } else {
      tagged = `{gray-fg}Stopped{/} — Press q or Ctrl+C to exit`;
    }
    bar.setContent(tagged);
    return;
  }
  const left = `run:${state.run_id} ${statusTagged(state.status)}`;
  const right = "q:quit  r:refresh";
  bar.setContent(`${left}{|}${right}`);
}
