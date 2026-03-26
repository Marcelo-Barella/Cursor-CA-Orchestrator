import blessed from "blessed";
import type { OrchestrationEvent } from "../../state.js";

function formatEventTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "??:??:??";
  return d.toISOString().slice(11, 19);
}

export function createEventLog(screen: blessed.Widgets.Screen): blessed.Widgets.Log {
  return blessed.log({
    parent: screen,
    left: "60%",
    top: 3,
    width: "40%",
    height: "100%-4",
    tags: true,
    border: "line",
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { style: { bg: "blue" } },
    label: " Events ",
  }) as blessed.Widgets.Log;
}

export function updateEventLog(
  log: blessed.Widgets.Log,
  events: OrchestrationEvent[],
  lastCount: number,
): number {
  const next = events.slice(lastCount);
  for (const event of next) {
    const t = formatEventTime(event.timestamp);
    const formattedLine = `{bold}[${t}]{/bold} ${event.detail}`;
    log.log(formattedLine);
  }
  return events.length;
}
