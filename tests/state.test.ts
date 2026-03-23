import { describe, expect, it } from "vitest";
import type { OrchestratorConfig } from "../src/config/types.js";
import { createInitialState, deserialize, serialize } from "../src/state.js";

describe("state", () => {
  it("roundtrip serialize", () => {
    const config: OrchestratorConfig = {
      name: "n",
      model: "m",
      prompt: "",
      repositories: {},
      tasks: [
        {
          id: "a",
          repo: "r",
          prompt: "p",
          model: null,
          depends_on: [],
          timeout_minutes: 30,
          create_repo: false,
          repo_config: null,
        },
      ],
      target: { auto_create_pr: true, branch_prefix: "x" },
      bootstrap_repo_name: "b",
    };
    const state = createInitialState(config, "run1");
    const s = serialize(state);
    const back = deserialize(s);
    expect(back.run_id).toBe("run1");
    expect(back.agents.a).toBeDefined();
  });
});
