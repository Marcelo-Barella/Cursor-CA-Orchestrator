import { describe, expect, it } from "vitest";
import { PLANNER_SYSTEM_PROMPT, WORKER_SYSTEM_PROMPT } from "../src/system-prompt.js";

describe("system-prompt copy", () => {
  it("planner: completeness stage and no silent MVP or layer drop", () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain("COMPLETENESS");
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/MVP|prototype|phase 2/i);
    expect(PLANNER_SYSTEM_PROMPT).toMatch(/explicit_deferrals|deferrals/i);
  });
  it("worker: resists scope shrink on layer work", () => {
    expect(WORKER_SYSTEM_PROMPT).toMatch(/MVP|thin/i);
  });
});
