import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

export type CacheSource = "fresh" | "stale" | "fetched" | "none";

export type CacheResult<T> = {
  data: T | null;
  source: CacheSource;
  fetchedAt: Date | null;
  error: Error | null;
};

type FileShape<T> = { fetchedAt: string; data: T };

function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

export class DiskCache {
  private readonly root: string;

  constructor(apiKey: string, opts: { homeDir?: string } = {}) {
    const home = opts.homeDir ?? os.homedir();
    this.root = path.join(home, ".cursor-orch", "cache", hashApiKey(apiKey));
  }

  pathFor(name: string): string {
    return path.join(this.root, `${name}.json`);
  }

  async get<T>(name: string, ttlMs: number, loader: () => Promise<T>): Promise<CacheResult<T>> {
    const existing = await this.readFile<T>(name);
    if (existing && Date.now() - existing.fetchedAt.getTime() < ttlMs) {
      return { data: existing.data, source: "fresh", fetchedAt: existing.fetchedAt, error: null };
    }
    try {
      const data = await loader();
      const fetchedAt = new Date();
      await this.writeFile(name, { fetchedAt: fetchedAt.toISOString(), data });
      return { data, source: "fetched", fetchedAt, error: null };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (existing) {
        return { data: existing.data, source: "stale", fetchedAt: existing.fetchedAt, error: err };
      }
      return { data: null, source: "none", fetchedAt: null, error: err };
    }
  }

  async invalidate(name: string): Promise<void> {
    await fsp.rm(this.pathFor(name), { force: true });
  }

  async age(name: string): Promise<Date | null> {
    const f = await this.readFile<unknown>(name);
    return f ? f.fetchedAt : null;
  }

  private async readFile<T>(name: string): Promise<{ fetchedAt: Date; data: T } | null> {
    const file = this.pathFor(name);
    if (!fs.existsSync(file)) {
      return null;
    }
    try {
      const text = await fsp.readFile(file, "utf8");
      const parsed = JSON.parse(text) as FileShape<T>;
      if (typeof parsed !== "object" || parsed === null || typeof parsed.fetchedAt !== "string") {
        return null;
      }
      const t = Date.parse(parsed.fetchedAt);
      if (Number.isNaN(t)) {
        return null;
      }
      return { fetchedAt: new Date(t), data: parsed.data };
    } catch {
      return null;
    }
  }

  private async writeFile<T>(name: string, payload: FileShape<T>): Promise<void> {
    const file = this.pathFor(name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(payload), "utf8");
    await fsp.rename(tmp, file);
  }
}
