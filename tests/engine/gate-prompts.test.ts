import { describe, expect, it } from "vitest";
import { buildGatePrompt } from "../../src/engine/gate-prompts.js";

describe("gate prompts", () => {
  it("computer_use prompt requires local cloud VM app", () => {
    const p = buildGatePrompt({
      gate: "computer_use",
      runId: "r1",
      repoUrl: "https://github.com/acme/app",
      runBranch: "cursor-orch/r1/main/run",
      bootstrapOwner: "acme",
      bootstrapRepo: "cursor-orch-bootstrap",
    });
    expect(p).toMatch(/localhost|127\.0\.0\.1|local(ly)? in (this )?cloud VM/i);
    expect(p).toMatch(/do not.*preview/i);
    expect(p).toContain("gate-results/computer_use.json");
  });

  it("code_quality and code_review prompts name their artifacts", () => {
    for (const gate of ["code_quality", "code_review"] as const) {
      const p = buildGatePrompt({
        gate,
        runId: "r1",
        repoUrl: "https://github.com/acme/app",
        runBranch: "b",
        bootstrapOwner: "o",
        bootstrapRepo: "b",
      });
      expect(p).toContain(`gate-results/${gate}.json`);
      expect(p).toMatch(/blocking/);
    }
  });
});
