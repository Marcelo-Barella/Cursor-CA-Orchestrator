import { describe, expect, it } from "vitest";
import { runOrchestration } from "../src/orchestrator.js";
import { toYaml } from "../src/config/parse.js";
import type { OrchestratorConfig } from "../src/config/types.js";
import { FakeAgentClient, statusMessage } from "./support/fake-agent-client.js";
import { createInMemoryRepoStore } from "./support/reattach-fixtures.js";

function twoTaskChainConfig(): OrchestratorConfig {
  return {
    name: "demo",
    model: { id: "composer-2" },
    prompt: "",
    repositories: { svc: { url: "https://github.com/acme/svc", ref: "main" } },
    tasks: [
      {
        id: "t1",
        repo: "svc",
        prompt: "Upstream.",
        model: null,
        depends_on: [],
        timeout_minutes: 30,
        create_repo: false,
        repo_config: null,
      },
      {
        id: "t2",
        repo: "svc",
        prompt: "Dependent.",
        model: null,
        depends_on: ["t1"],
        timeout_minutes: 30,
        create_repo: false,
        repo_config: null,
      },
    ],
    target: { auto_create_pr: false, consolidate_prs: false, branch_prefix: "cursor-orch", branch_layout: "per_task" },
    bootstrap_repo_name: "cursor-orch-bootstrap",
  };
}

describe("stopped upstream cascade", () => {
  it("terminates when upstream is cancelled and dependent stays pending", async () => {
    const config = twoTaskChainConfig();
    const fake = new FakeAgentClient({
      defaultScripts: [
        {
          events: [statusMessage("RUNNING")],
          result: { id: "r-t1", status: "cancelled" },
        },
      ],
    });
    const { store, files } = createInMemoryRepoStore({ "config.yaml": toYaml(config) });

    const run = runOrchestration("run-stopped-cascade-hang", fake, store);
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("orchestration hung")), 2500);
    });
    await Promise.race([run, timeout]);

    const state = JSON.parse(files.get("state.json")!);
    expect(state.agents.t1.status).toBe("stopped");
    expect(state.agents.t2.status).toBe("stopped");
    expect(state.agents.t2.cascade_source_task_id).toBe("t1");
    expect(state.status).toBe("stopped");
    expect(fake.launches).toHaveLength(1);
  });
});
