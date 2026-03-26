import blessed from "blessed";
import type { OrchestrationState } from "../../state.js";

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
    tags: true,
    style: { fg: "white", bg: "blue" },
  });
}

export function updateStatusBar(bar: blessed.Widgets.BoxElement, state: OrchestrationState): void {
  const left = `run:${state.run_id} ${statusTagged(state.status)}`;
  const right = "q:quit  r:refresh";
  bar.setContent(`${left}{|}${right}`);
}
