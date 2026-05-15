import type { BootstrapRepoStore } from "../storage/bootstrap-repo-store.js";
import { mirrorTasksFromOrchestrationState } from "./normalize.js";

export async function readBootstrapSnapshot(store: BootstrapRepoStore) {
  const state = await store.readOrchestrationState();
  return {
    tasks: mirrorTasksFromOrchestrationState(state),
    raw: state,
  };
}
