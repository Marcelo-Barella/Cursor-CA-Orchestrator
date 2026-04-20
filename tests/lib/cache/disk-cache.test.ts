import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DiskCache } from "../../../src/lib/cache/disk-cache.js";

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cursor-orch-cache-"));
}

describe("DiskCache", () => {
  it("fresh hit returns without calling loader", async () => {
    const home = tempHome();
    const cache = new DiskCache("sk-1", { homeDir: home });
    const loader = vi.fn(async () => ["a"]);
    const r1 = await cache.get("models", 60_000, loader);
    expect(r1.source).toBe("fetched");
    expect(r1.data).toEqual(["a"]);
    const r2 = await cache.get("models", 60_000, loader);
    expect(r2.source).toBe("fresh");
    expect(r2.data).toEqual(["a"]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("expired TTL triggers loader and rewrites file", async () => {
    const home = tempHome();
    const cache = new DiskCache("sk-1", { homeDir: home });
    await cache.get("models", 60_000, async () => ["old"]);
    const older = Date.now() - 120_000;
    const file = cache.pathFor("models");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { fetchedAt: string; data: string[] };
    raw.fetchedAt = new Date(older).toISOString();
    fs.writeFileSync(file, JSON.stringify(raw), "utf8");
    const r = await cache.get("models", 60_000, async () => ["new"]);
    expect(r.source).toBe("fetched");
    expect(r.data).toEqual(["new"]);
  });

  it("loader error with stale file returns stale data", async () => {
    const home = tempHome();
    const cache = new DiskCache("sk-1", { homeDir: home });
    await cache.get("models", 60_000, async () => ["v1"]);
    const file = cache.pathFor("models");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { fetchedAt: string; data: string[] };
    raw.fetchedAt = new Date(Date.now() - 120_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(raw), "utf8");
    const r = await cache.get("models", 60_000, async () => {
      throw new Error("boom");
    });
    expect(r.source).toBe("stale");
    expect(r.data).toEqual(["v1"]);
    expect(r.error?.message).toBe("boom");
  });

  it("loader error with no file returns null + error", async () => {
    const home = tempHome();
    const cache = new DiskCache("sk-1", { homeDir: home });
    const r = await cache.get("models", 60_000, async () => {
      throw new Error("down");
    });
    expect(r.source).toBe("none");
    expect(r.data).toBeNull();
    expect(r.error?.message).toBe("down");
  });

  it("invalidate removes the file", async () => {
    const home = tempHome();
    const cache = new DiskCache("sk-1", { homeDir: home });
    await cache.get("models", 60_000, async () => ["x"]);
    await cache.invalidate("models");
    expect(fs.existsSync(cache.pathFor("models"))).toBe(false);
  });

  it("age returns fetchedAt without reading data", async () => {
    const home = tempHome();
    const cache = new DiskCache("sk-1", { homeDir: home });
    await cache.get("models", 60_000, async () => ["x"]);
    const a = await cache.age("models");
    expect(a).toBeInstanceOf(Date);
    expect(Math.abs((a as Date).getTime() - Date.now())).toBeLessThan(5_000);
  });

  it("age returns null when file missing", async () => {
    const home = tempHome();
    const cache = new DiskCache("sk-1", { homeDir: home });
    expect(await cache.age("models")).toBeNull();
  });

  it("different api keys produce different roots", async () => {
    const home = tempHome();
    const a = new DiskCache("key-A", { homeDir: home });
    const b = new DiskCache("key-B", { homeDir: home });
    expect(path.dirname(a.pathFor("models"))).not.toBe(path.dirname(b.pathFor("models")));
  });

  it("corrupted JSON triggers loader (treated as no file)", async () => {
    const home = tempHome();
    const cache = new DiskCache("sk-1", { homeDir: home });
    await fsp.mkdir(path.dirname(cache.pathFor("models")), { recursive: true });
    fs.writeFileSync(cache.pathFor("models"), "not json", "utf8");
    const r = await cache.get("models", 60_000, async () => ["fresh"]);
    expect(r.source).toBe("fetched");
    expect(r.data).toEqual(["fresh"]);
  });
});
