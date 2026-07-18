import type { OrchestrationPhase } from "../state.js";

export type PhaseEvent =
  | "plan_ready"
  | "implement_done"
  | "integrate_ok"
  | "integrate_conflict"
  | "gates_pass"
  | "gates_fail"
  | "fix_scheduled"
  | "replan_scheduled"
  | "finalize_done"
  | "stop"
  | "cap_exceeded";

export function nextPhase(phase: OrchestrationPhase, event: PhaseEvent): OrchestrationPhase {
  if (event === "stop") return "stopped";
  if (event === "cap_exceeded") return "failed";

  switch (phase) {
    case "plan":
      if (event === "plan_ready") return "implement";
      break;
    case "implement":
      if (event === "implement_done") return "integrate";
      break;
    case "integrate":
      if (event === "integrate_ok") return "gate";
      if (event === "integrate_conflict") return "fix";
      if (event === "fix_scheduled") return "fix";
      if (event === "replan_scheduled") return "replan";
      break;
    case "gate":
      if (event === "gates_pass") return "finalize";
      if (event === "fix_scheduled") return "fix";
      if (event === "replan_scheduled") return "replan";
      break;
    case "fix":
      if (event === "fix_scheduled") return "implement";
      break;
    case "replan":
      if (event === "replan_scheduled") return "plan";
      break;
    case "finalize":
      if (event === "finalize_done") return "completed";
      break;
    case "completed":
    case "failed":
    case "stopped":
      return phase;
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
  throw new Error(`Invalid transition ${phase} + ${event}`);
}

export function shouldHonorStopBetweenPhases(phase: OrchestrationPhase): boolean {
  return phase !== "completed" && phase !== "failed" && phase !== "stopped";
}
