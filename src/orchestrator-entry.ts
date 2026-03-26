import { runOrchestrationMain } from "./orchestrator.js";

void runOrchestrationMain().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
