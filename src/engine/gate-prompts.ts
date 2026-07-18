import type { GateId } from "./iteration-policy.js";
import { gateResultBoardPath } from "./gates.js";

export type BuildGatePromptInput = {
  gate: GateId;
  runId: string;
  repoUrl: string;
  runBranch: string;
  bootstrapOwner: string;
  bootstrapRepo: string;
};

function boardWriteInstructions(input: BuildGatePromptInput): string {
  const path = gateResultBoardPath(input.gate);
  return [
    `Write the gate result JSON to the bootstrap board via gh api Contents API on branch run/${input.runId}.`,
    `Artifact path: ${path}`,
    `Bootstrap repo: ${input.bootstrapOwner}/${input.bootstrapRepo}`,
    "JSON shape: { gate, passed: boolean, findings: [{ severity: \"blocking\"|\"info\", message, path? }], summary: string }.",
    "Use severity \"blocking\" for failures that must fail the gate.",
  ].join("\n");
}

export function buildGatePrompt(input: BuildGatePromptInput): string {
  const common = [
    `Gate: ${input.gate}`,
    `Product repo: ${input.repoUrl}`,
    `Inspect run branch: ${input.runBranch}`,
    boardWriteInstructions(input),
  ].join("\n");

  switch (input.gate) {
    case "code_quality":
      return [
        common,
        "Review maintainability, structure, and complexity (thermo-style).",
        "Pass only with no blocking findings.",
      ].join("\n");
    case "code_review":
      return [
        common,
        "Review correctness, regressions, security, and API drift.",
        "Pass only with no blocking findings.",
      ].join("\n");
    case "computer_use":
      return [
        common,
        "Install, build, and start the app locally in this cloud VM.",
        "Drive the UI with computer-use against localhost or 127.0.0.1 (local bind).",
        "Do not use a remote preview or deploy URL as the primary target.",
        "Exercise primary flows; on failure include repro steps in findings.",
      ].join("\n");
    default: {
      const _exhaustive: never = input.gate;
      return _exhaustive;
    }
  }
}
