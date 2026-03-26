import blessed from "blessed";
import type { OrchestratorConfig } from "../config/types.js";
import type { OrchestrationEvent, OrchestrationState } from "../state.js";

export interface TUIWidgets {
  screen: blessed.Widgets.Screen;
  headerBox: blessed.Widgets.BoxElement;
  taskTable: blessed.Widgets.ListTableElement;
  eventLog: blessed.Widgets.Log;
  statusBar: blessed.Widgets.BoxElement;
}

export interface TUIState {
  state: OrchestrationState;
  config: OrchestratorConfig;
  events: OrchestrationEvent[];
}

export function createScreen(): blessed.Widgets.Screen {
  return blessed.screen({
    smartCSR: true,
    title: "cursor-orch",
    fullUnicode: true,
    autoPadding: true,
  });
}
