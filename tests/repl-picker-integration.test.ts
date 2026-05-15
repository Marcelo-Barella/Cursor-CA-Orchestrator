import type { ModelListItem } from "@cursor/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Session } from "../src/session.js";
import { buildRefreshDeps } from "../src/repl.js";
import { CursorApiClient } from "../src/api/cursor-api-client.js";
import { DiskCache } from "../src/lib/cache/disk-cache.js";
import { fetchModelsCatalog } from "../src/lib/models-catalog.js";
import { MODELS_CATALOG_CACHE_KEY, MODELS_TTL_MS } from "../src/lib/repl/pickers/picker-context.js";

vi.mock("../src/lib/models-catalog.js", () => ({
  fetchModelsCatalog: vi.fn(async () => [{ id: "stub-model", displayName: "Stub" }]),
}));

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
    const deps = buildRefreshDeps({ api, cache, apiKey: "sk-test" });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ models: ["a", "b", "c"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const r = await deps.refreshModels();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.count).toBe(1);
      expect(r.restIdCount).toBe(3);
    }
    expect(fs.existsSync(cache.pathFor("models"))).toBe(true);
    expect(fs.existsSync(cache.pathFor(MODELS_CATALOG_CACHE_KEY))).toBe(true);
  });

  it("refreshModels persists catalog ModelListItem entries with variants for picker", async () => {
    const catalogWithVariants: ModelListItem[] = [
      {
        id: "gpt-5.5",
        displayName: "GPT 5.5",
        variants: [{ displayName: "High", params: [{ id: "reasoning_effort", value: "high" }] }],
      },
    ];
    vi.mocked(fetchModelsCatalog).mockImplementationOnce(async () => catalogWithVariants);
    const home = tempHome();
    const cache = new DiskCache("sk-test", { homeDir: home });
    const api = new CursorApiClient("sk-test", { sleep: async () => {} });
    const deps = buildRefreshDeps({ api, cache, apiKey: "sk-test" });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ models: ["a"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const r = await deps.refreshModels();
    expect(r.ok).toBe(true);
    const cached = await cache.get<ModelListItem[]>(
      MODELS_CATALOG_CACHE_KEY,
      MODELS_TTL_MS,
      async () => Promise.reject(new Error("catalog loader should not run when cache is fresh")),
    );
    expect(cached.source).toBe("fresh");
    expect(cached.data).toEqual(catalogWithVariants);
    expect(cached.data?.[0]?.id).toBe("gpt-5.5");
    expect(cached.data?.[0]?.variants?.[0]?.params?.[0]).toEqual({ id: "reasoning_effort", value: "high" });
  });

  it("refreshRepos failure surfaces error and leaves no file", async () => {
    const home = tempHome();
    const cache = new DiskCache("sk-test", { homeDir: home });
    const api = new CursorApiClient("sk-test", { sleep: async () => {} });
    const deps = buildRefreshDeps({ api, cache, apiKey: "sk-test" });
    fetchMock.mockResolvedValue(new Response("", { status: 429 }));
    const r = await deps.refreshRepos();
    expect(r.ok).toBe(false);
    expect(fs.existsSync(cache.pathFor("repositories"))).toBe(false);
  });

  it("ages return null for unfetched, Date for fetched", async () => {
    const home = tempHome();
    const cache = new DiskCache("sk-test", { homeDir: home });
    const api = new CursorApiClient("sk-test", { sleep: async () => {} });
    const deps = buildRefreshDeps({ api, cache, apiKey: "sk-test" });
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
