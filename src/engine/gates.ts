import type { GateId } from "./iteration-policy.js";

export type GateFinding = { severity: "blocking" | "info"; message: string; path?: string };
export type GateResult = { gate: GateId; passed: boolean; findings: GateFinding[]; summary: string };

export const GATE_IDS: GateId[] = ["code_quality", "code_review", "computer_use"];

export function gateResultBoardPath(gate: GateId): string {
  return `gate-results/${gate}.json`;
}

function isGateId(v: unknown): v is GateId {
  return v === "code_quality" || v === "code_review" || v === "computer_use";
}

export function parseGateResult(raw: unknown): GateResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Gate result must be an object");
  }
  const o = raw as Record<string, unknown>;
  if (!isGateId(o.gate)) {
    throw new Error(`Invalid gate id: ${String(o.gate)}`);
  }
  if (typeof o.passed !== "boolean") {
    throw new Error("Gate result.passed must be boolean");
  }
  if (typeof o.summary !== "string") {
    throw new Error("Gate result.summary must be string");
  }
  if (!Array.isArray(o.findings)) {
    throw new Error("Gate result.findings must be an array");
  }
  const findings: GateFinding[] = o.findings.map((f, i) => {
    if (typeof f !== "object" || f === null || Array.isArray(f)) {
      throw new Error(`Invalid finding at index ${i}`);
    }
    const fr = f as Record<string, unknown>;
    if (fr.severity !== "blocking" && fr.severity !== "info") {
      throw new Error(`Invalid finding severity at index ${i}`);
    }
    if (typeof fr.message !== "string") {
      throw new Error(`Invalid finding message at index ${i}`);
    }
    const out: GateFinding = { severity: fr.severity, message: fr.message };
    if (fr.path !== undefined) {
      if (typeof fr.path !== "string") throw new Error(`Invalid finding path at index ${i}`);
      out.path = fr.path;
    }
    return out;
  });
  const hasBlocking = findings.some((f) => f.severity === "blocking");
  return {
    gate: o.gate,
    passed: o.passed && !hasBlocking,
    findings,
    summary: o.summary,
  };
}

export function allGatesPassed(results: GateResult[]): boolean {
  return results.length > 0 && results.every((r) => r.passed);
}

export function failedGateIds(results: GateResult[]): GateId[] {
  return results.filter((r) => !r.passed).map((r) => r.gate);
}
