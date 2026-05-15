export { type OrchestratorConfig } from "./config/types.js";

export async function launchOrchestrationRun(): Promise<{ orchestrationRunId: string }> {
  throw new Error("launchOrchestrationRun not wired");
}
