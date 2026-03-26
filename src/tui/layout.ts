import blessed from "blessed";
import type { TUIState, TUIWidgets } from "./screen.js";
import { createEventLog, updateEventLog } from "./widgets/event-log.js";
import { createHeader, updateHeader } from "./widgets/header.js";
import { createStatusBar, updateStatusBar } from "./widgets/status-bar.js";
import { createTaskTable, updateTaskTable } from "./widgets/task-table.js";

export function buildLayout(screen: blessed.Widgets.Screen): TUIWidgets {
  const headerBox = createHeader(screen);
  const taskTable = createTaskTable(screen);
  const eventLog = createEventLog(screen);
  const statusBar = createStatusBar(screen);

  screen.key(["q", "C-c"], () => {
    screen.destroy();
    process.exit(0);
  });

  screen.on("resize", () => {
    screen.render();
  });

  return {
    screen,
    headerBox,
    taskTable,
    eventLog,
    statusBar,
  };
}

export function updateAll(
  widgets: TUIWidgets,
  tuiState: TUIState,
  lastEventCount: number,
): number {
  updateHeader(widgets.headerBox, tuiState.state, tuiState.config);
  updateTaskTable(widgets.taskTable, tuiState.state, tuiState.config);
  const newCount = updateEventLog(
    widgets.eventLog,
    tuiState.events,
    lastEventCount,
  );
  updateStatusBar(widgets.statusBar, tuiState.state);
  return newCount;
}
