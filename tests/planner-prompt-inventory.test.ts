import { describe, expect, it } from "vitest";
import { buildPlannerPrompt } from "../src/planner.js";
import type { InventoryManifestV1, OrchestratorConfig } from "../src/config/types.js";
import { countOrchestrationPromptTokens } from "../src/lib/prompt-token-count.js";

const base: OrchestratorConfig = {
  name: "n",
  model: "m",
  prompt: "Build the product.",
  repositories: { svc: { url: "https://github.com/o/r", ref: "main" } },
  tasks: [],
  target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "p", branch_layout: "consolidated" },
  bootstrap_repo_name: "b",
};

const inventory: InventoryManifestV1 = {
  version: 1,
  source: "declared",
  product_class: "web_app",
  layers: ["client", "api", "persistence"],
  explicit_deferrals: [],
  required_integrations: ["oauth"],
  greenfield: true,
};

describe("planner prompt inventory", () => {
  it("buildPlannerPrompt includes ## Inventory and manifest JSON when config.inventory is set", () => {
    const p = buildPlannerPrompt({ ...base, inventory }, "run-1", "o", "b");
    expect(p).toContain("## Inventory");
    expect(p).toContain('"product_class": "web_app"');
    expect(p).toContain('"layers"');
  });

  it("omits ## Inventory when inventory is unset", () => {
    const p = buildPlannerPrompt(base, "run-1", "o", "b");
    expect(p).not.toContain("## Inventory");
  });

  it("planner prompt with inventory stays within a reasonable token budget", () => {
    const longLayer = "layer-" + "x".repeat(120);
    const layers = Array.from({ length: 10 }, (_, i) => `${longLayer}-${i}`);
    const big: InventoryManifestV1 = {
      ...inventory,
      layers,
      required_integrations: Array.from({ length: 10 }, (_, i) => `integration-${i}-${"y".repeat(80)}`),
    };
    const p = buildPlannerPrompt({ ...base, inventory: big }, "run-1", "o", "b");
    const n = countOrchestrationPromptTokens(p);
    expect(n).toBeLessThan(12000);
  });
});
