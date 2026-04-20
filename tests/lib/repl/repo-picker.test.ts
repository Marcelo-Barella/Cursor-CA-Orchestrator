import { describe, expect, it } from "vitest";
import type { RepoInfo } from "../../../src/api/cursor-api-client.js";
import type { CacheResult } from "../../../src/lib/cache/disk-cache.js";
import {
  runRepoPicker,
  type RepoPickerDeps,
  type RepoPickerAdd,
} from "../../../src/lib/repl/pickers/repo-picker.js";

const REPOS: RepoInfo[] = [
  { owner: "acme", name: "api", repository: "https://github.com/acme/api" },
  { owner: "acme", name: "web", repository: "https://github.com/acme/web" },
];

function makeReader(answers: string[]): () => Promise<string | null> {
  let i = 0;
  return async () => (i < answers.length ? (answers[i++] ?? null) : null);
}

function baseDeps(overrides: Partial<RepoPickerDeps> = {}): { deps: RepoPickerDeps; added: RepoPickerAdd[]; logs: string[] } {
  const added: RepoPickerAdd[] = [];
  const logs: string[] = [];
  const deps: RepoPickerDeps = {
    listRepositories: async (): Promise<CacheResult<RepoInfo[]>> => ({
      data: REPOS,
      source: "fresh",
      fetchedAt: new Date(),
      error: null,
    }),
    pick: async (items) => ({ kind: "selected", values: items }),
    readLine: makeReader([]),
    writeLine: (s) => logs.push(s),
    existingAliases: new Set<string>(),
    addRepo: (a, u, r) => {
      added.push({ alias: a, url: u, ref: r });
    },
    fallbackInteractive: async () => {
      added.push({ alias: "manual", url: "https://example.com", ref: "main" });
    },
    isTTY: true,
    ...overrides,
  };
  return { deps, added, logs };
}

describe("runRepoPicker", () => {
  it("adds selected repos with default alias and ref on blank prompts", async () => {
    const { deps, added } = baseDeps({
      readLine: makeReader(["", "", "", ""]),
    });
    await runRepoPicker(deps);
    expect(added).toEqual([
      { alias: "api", url: "https://github.com/acme/api", ref: "main" },
      { alias: "web", url: "https://github.com/acme/web", ref: "main" },
    ]);
  });

  it("respects custom alias and ref", async () => {
    const { deps, added } = baseDeps({
      readLine: makeReader(["api-alias", "develop", "web", "main"]),
    });
    await runRepoPicker(deps);
    expect(added[0]).toEqual({ alias: "api-alias", url: "https://github.com/acme/api", ref: "develop" });
    expect(added[1]).toEqual({ alias: "web", url: "https://github.com/acme/web", ref: "main" });
  });

  it("reprompts on alias collision with existing and batch", async () => {
    const { deps, added, logs } = baseDeps({
      existingAliases: new Set(["api"]),
      readLine: makeReader(["api", "api-new", "main", "api-new", "api-newer", "main"]),
    });
    await runRepoPicker(deps);
    expect(added[0]?.alias).toBe("api-new");
    expect(added[1]?.alias).toBe("api-newer");
    expect(logs.some((l) => l.includes("already used"))).toBe(true);
  });

  it("falls back to interactive prompt when no repos available", async () => {
    const { deps, added, logs } = baseDeps({
      listRepositories: async () => ({ data: null, source: "none", fetchedAt: null, error: new Error("down") }),
    });
    await runRepoPicker(deps);
    expect(added).toEqual([{ alias: "manual", url: "https://example.com", ref: "main" }]);
    expect(logs.some((l) => l.includes("Repository list unavailable"))).toBe(true);
  });

  it("prints stale warning when source is stale", async () => {
    const { deps, logs } = baseDeps({
      listRepositories: async () => ({
        data: REPOS,
        source: "stale",
        fetchedAt: new Date(Date.now() - 3_600_000),
        error: new Error("down"),
      }),
      readLine: makeReader(["", "", "", ""]),
    });
    await runRepoPicker(deps);
    expect(logs.some((l) => l.includes("Using stale repositories cache"))).toBe(true);
  });

  it("picker cancel aborts without adds", async () => {
    const { deps, added } = baseDeps({
      pick: async () => ({ kind: "cancelled" }),
    });
    await runRepoPicker(deps);
    expect(added).toEqual([]);
  });

  it("EOF during alias prompt aborts the batch with no partial adds", async () => {
    const { deps, added } = baseDeps({
      readLine: makeReader([]),
    });
    await runRepoPicker(deps);
    expect(added).toEqual([]);
  });
});
