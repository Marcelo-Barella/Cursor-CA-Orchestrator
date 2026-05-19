import type { BootstrapRepoStore } from "../storage/bootstrap-repo-store.js";

export interface LaunchOrchestrationRunDeps {
  cwd: string;
  runOrchestration: () => Promise<{ orchestrationRunId: string }>;
  store?: BootstrapRepoStore;
}

export async function launchOrchestrationRun(
  deps: LaunchOrchestrationRunDeps,
): Promise<{ orchestrationRunId: string }> {
  return deps.runOrchestration();
}
