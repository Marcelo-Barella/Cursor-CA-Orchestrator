import { describe, expect, it, vi } from "vitest";
import { cmdRefresh, type RefreshDeps } from "../src/commands.js";

function deps(overrides: Partial<RefreshDeps> = {}): RefreshDeps {
  return {
    refreshModels: async () => ({ ok: true, count: 3, fetchedAt: new Date() }),
    refreshRepos: async () => ({ ok: true, count: 5, fetchedAt: new Date() }),
    ageModels: async () => new Date(Date.now() - 60_000),
    ageRepos: async () => new Date(Date.now() - 120_000),
    ...overrides,
  };
}

describe("cmdRefresh", () => {
  it("bare prints current ages for both", async () => {
    const out = await cmdRefresh(undefined, deps());
    expect(out).toMatch(/models.*1m/);
    expect(out).toMatch(/repositories.*2m/);
  });

  it("models succeeds with count", async () => {
    const out = await cmdRefresh("models", deps());
    expect(out).toMatch(/models refreshed.*3/);
  });

  it("repos failure surfaces error and does not touch models", async () => {
    const d = deps({
      refreshRepos: async () => ({ ok: false, error: new Error("429") }),
    });
    const spyModels = vi.fn(d.refreshModels);
    d.refreshModels = spyModels;
    const out = await cmdRefresh("repos", d);
    expect(out).toMatch(/repositories refresh failed.*429/);
    expect(spyModels).not.toHaveBeenCalled();
  });

  it("all runs both in order", async () => {
    const d = deps();
    const out = await cmdRefresh("all", d);
    expect(out).toMatch(/models refreshed/);
    expect(out).toMatch(/repositories refreshed/);
  });

  it("unknown target returns usage error", async () => {
    const out = await cmdRefresh("bogus", deps());
    expect(out.toLowerCase()).toContain("usage");
  });

  it("missing deps when cache unavailable returns error string", async () => {
    const out = await cmdRefresh("models", null);
    expect(out).toMatch(/CURSOR_API_KEY/);
  });
});
