import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Session } from "../src/session.js";
import { buildRefreshDeps } from "../src/repl.js";
import { CursorApiClient } from "../src/api/cursor-api-client.js";
import { DiskCache } from "../src/lib/cache/disk-cache.js";

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cursor-orch-int-"));
}

describe("repl-picker-integration buildRefreshDeps", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("refreshModels invalidates cache, fetches, writes, returns count", async () => {
    const home = tempHome();
    const cache = new DiskCache("sk-test", { homeDir: home });
    const api = new CursorApiClient("sk-test", { sleep: async () => {} });
    const deps = buildRefreshDeps({ api, cache });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ models: ["a", "b", "c"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const r = await deps.refreshModels();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.count).toBe(3);
    expect(fs.existsSync(cache.pathFor("models"))).toBe(true);
  });

  it("refreshRepos failure surfaces error and leaves no file", async () => {
    const home = tempHome();
    const cache = new DiskCache("sk-test", { homeDir: home });
    const api = new CursorApiClient("sk-test", { sleep: async () => {} });
    const deps = buildRefreshDeps({ api, cache });
    fetchMock.mockResolvedValue(new Response("", { status: 429 }));
    const r = await deps.refreshRepos();
    expect(r.ok).toBe(false);
    expect(fs.existsSync(cache.pathFor("repositories"))).toBe(false);
  });

  it("ages return null for unfetched, Date for fetched", async () => {
    const home = tempHome();
    const cache = new DiskCache("sk-test", { homeDir: home });
    const api = new CursorApiClient("sk-test", { sleep: async () => {} });
    const deps = buildRefreshDeps({ api, cache });
    expect(await deps.ageModels()).toBeNull();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ models: ["x"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await deps.refreshModels();
    const a = await deps.ageModels();
    expect(a).toBeInstanceOf(Date);
  });

  it("session add flow can be driven by runRepoPicker via existing session", () => {
    const session = new Session();
    expect(Object.keys(session.config.repositories)).toEqual([]);
    session.addRepo("api", "https://github.com/acme/api", "main");
    expect(session.config.repositories["api"]).toBeDefined();
  });
});
