export interface LaunchOrchestrationRunDeps {
  cwd: string;
  runOrchestration: () => Promise<{ orchestrationRunId: string }>;
}

export async function launchOrchestrationRun(
  deps: LaunchOrchestrationRunDeps,
): Promise<{ orchestrationRunId: string }> {
  return deps.runOrchestration();
}
