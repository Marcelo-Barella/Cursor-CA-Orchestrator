import { setTimeout as delay } from "node:timers/promises";
import type { RepoStoreClient } from "../api/repo-store.js";
import type { OrchestratorConfig } from "../config/types.js";
import { deserialize, readEvents } from "../state.js";
import { buildLayout, updateAll } from "./layout.js";
import { createScreen, type TUIState } from "./screen.js";

const POLL_INTERVAL = 10;
const TERMINAL_STATES = new Set(["completed", "failed", "stopped"]);

export async function renderLiveTUI(
  repoStore: RepoStoreClient,
  runId: string,
  config: OrchestratorConfig,
): Promise<void> {
  const screen = createScreen();
  const widgets = buildLayout(screen);
  let refreshRequested = false;
  screen.key("r", () => {
    refreshRequested = true;
  });
  let lastEventCount = 0;
  try {
    while (true) {
      const jsonStr = await repoStore.readFile(runId, "state.json");
      const state = deserialize(jsonStr);
      const events = await readEvents(repoStore, runId);
      const tuiState: TUIState = { state, config, events };
      lastEventCount = updateAll(widgets, tuiState, lastEventCount);
      screen.render();
      if (TERMINAL_STATES.has(state.status)) {
        await delay(2000);
        screen.destroy();
        break;
      }
      const deadline = Date.now() + POLL_INTERVAL * 1000;
      while (Date.now() < deadline) {
        if (refreshRequested) {
          break;
        }
        await delay(500);
      }
      refreshRequested = false;
    }
  } catch (err) {
    screen.destroy();
    throw err;
  }
}
