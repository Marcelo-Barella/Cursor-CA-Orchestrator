import { describe, expect, it, vi } from "vitest";
import type { RepoStoreClient } from "../src/api/repo-store.js";
import { createInitialState, serialize } from "../src/state.js";
import type { OrchestratorConfig } from "../src/config/types.js";
import {
  applyRunLimit,
  collectRunRows,
  parseNameFromConfigYaml,
  sortRunsNewestStartedFirst,
} from "../src/lib/commands/runs-list-impl.js";

function baseCfg(): OrchestratorConfig {
  return {
    name: "orch",
    model: { id: "m" },
    prompt: "",
    repositories: {},
    tasks: [{ id: "a", repo: "o/r", prompt: "", model: null, depends_on: [], timeout_minutes: 1, create_repo: false, repo_config: null }],
    target: { auto_create_pr: true, consolidate_prs: false, branch_prefix: "x", branch_layout: "consolidated" },
    bootstrap_repo_name: "b",
  };
}

function fakeStore(opts: {
  branches: string[];
  states: Record<string, { iso: string | null } | "bad">;
  names?: Record<string, string>;
  readImpl?: () => Promise<string>;
}): Pick<RepoStoreClient, "listRunBranches" | "readFile"> {
  const readFile = vi.fn(async (runId: string, path: string) => {
    if (path === "config.yaml") {
      const n = opts.names?.[runId];
      return n !== undefined ? `name: ${n}\n` : "";
    }
    if (path !== "state.json") return "";
    const ent = opts.states[runId];
    if (ent === undefined) throw new Error("no such file");
    if (ent === "bad") return "not-json{";
    const cfg = baseCfg();
    const st = createInitialState(cfg, runId);
    st.status = "running";
    st.started_at = ent.iso;
    return serialize(st);
  });
  return {
    listRunBranches: async () => opts.branches,
    readFile: opts.readImpl ?? readFile,
  };
}

describe("collectRunRows", () => {
  it("skips branches with bad JSON or read errors", async () => {
    const store = fakeStore({
      branches: ["run/a", "run/b", "run/c"],
      states: {
        a: "bad",
        b: { iso: "2020-01-02T00:00:00.000Z" },
        c: { iso: "2020-01-01T00:00:00.000Z" },
      },
    });
    const rows = await collectRunRows(store);
    expect(rows.map((r) => r.runId).sort()).toEqual(["b", "c"]);
  });

  it("sorts by started_at descending, invalid timestamps last", () => {
    const rows = [
      { runId: "early", name: "", status: "running", started_at: "2020-01-01T00:00:00.000Z", taskCount: 1 },
      { runId: "late", name: "", status: "running", started_at: "2021-01-01T00:00:00.000Z", taskCount: 1 },
      { runId: "bad-ts", name: "", status: "running", started_at: "not-a-date", taskCount: 1 },
      { runId: "null-ts", name: "", status: "pending", started_at: null, taskCount: 0 },
    ];
    const sorted = sortRunsNewestStartedFirst(rows);
    expect(sorted.slice(0, 2).map((r) => r.runId)).toEqual(["late", "early"]);
    expect(new Set(sorted.slice(2).map((r) => r.runId))).toEqual(new Set(["bad-ts", "null-ts"]));
  });

  it("applies limit after sort", async () => {
    const store = fakeStore({
      branches: ["run/old", "run/new"],
      states: {
        old: { iso: "2020-01-01T00:00:00.000Z" },
        new: { iso: "2022-01-01T00:00:00.000Z" },
      },
    });
    const rows = sortRunsNewestStartedFirst(await collectRunRows(store));
    expect(applyRunLimit(rows, 1)[0]?.runId).toBe("new");
  });

  it("uses bounded parallelism (stress)", async () => {
    let active = 0;
    let peak = 0;
    const branches = Array.from({ length: 20 }, (_, i) => `run/r${i}`);
    const states: Record<string, { iso: string | null }> = {};
    for (let i = 0; i < 20; i++) {
      states[`r${i}`] = { iso: `2020-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` };
    }
    const store = fakeStore({ branches, states });
    const orig = store.readFile.bind(store);
    store.readFile = vi.fn(async (runId: string, path: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((r) => setImmediate(r));
      active--;
      return orig(runId, path);
    });
    await collectRunRows(store as Pick<RepoStoreClient, "listRunBranches" | "readFile">, 5);
    expect(peak).toBeLessThanOrEqual(5);
  });

  it("reads display name from config.yaml", async () => {
    const store = fakeStore({
      branches: ["run/x"],
      states: { x: { iso: "2020-01-01T00:00:00.000Z" } },
      names: { x: "My Orch" },
    });
    const rows = await collectRunRows(store);
    expect(rows[0]?.name).toBe("My Orch");
  });
});

describe("parseNameFromConfigYaml", () => {
  it("returns trimmed name or empty", () => {
    expect(parseNameFromConfigYaml("name: hi\n")).toBe("hi");
    expect(parseNameFromConfigYaml("other: 1\n")).toBe("");
  });
});
