export type GateId = "code_quality" | "code_review" | "computer_use";

export type RecoveryDecision = {
  action: "fix" | "replan" | "fail_cap";
  iteration: number;
};

export function decideRecovery(input: {
  failedGates: GateId[];
  gatesFailedAfterFix: GateId[];
  claimCollision: boolean;
  iteration: number;
  maxIterations: number;
}): RecoveryDecision {
  const { failedGates, gatesFailedAfterFix, claimCollision, iteration, maxIterations } = input;
  if (iteration >= maxIterations) {
    return { action: "fail_cap", iteration };
  }
  const nextIteration = iteration + 1;
  if (claimCollision) {
    return { action: "replan", iteration: nextIteration };
  }
  const repeat = failedGates.some((g) => gatesFailedAfterFix.includes(g));
  if (repeat) {
    return { action: "replan", iteration: nextIteration };
  }
  return { action: "fix", iteration: nextIteration };
}
