import { afterEach, describe, expect, it, vi } from "vitest";
import type { CursorApiClient } from "../src/api/cursor-api-client.js";
import type { DiskCache } from "../src/lib/cache/disk-cache.js";
import {
  cmdModelSlash,
  CURSOR_ORCH_ALLOW_UNKNOWN_MODEL_ENV,
  validateModelIdInCatalog,
} from "../src/commands.js";
import type { PickerContext } from "../src/lib/repl/pickers/picker-context.js";
import { Session } from "../src/session.js";

function makeCtx(catalog: { id: string }[]): PickerContext {
  return {
    apiKey: "test-key",
    api: {} as CursorApiClient,
    cache: {
      get: vi.fn(async () => ({
        data: catalog,
        source: "fresh" as const,
        fetchedAt: new Date(),
        error: null,
      })),
    } as unknown as DiskCache,
  };
}

describe("validateModelIdInCatalog", () => {
  afterEach(() => {
    delete process.env[CURSOR_ORCH_ALLOW_UNKNOWN_MODEL_ENV];
  });

  it("returns null without picker context", async () => {
    expect(await validateModelIdInCatalog("x", null)).toBeNull();
  });

  it("returns null when catalog snapshot is empty", async () => {
    const ctx = makeCtx([]);
    expect(await validateModelIdInCatalog("any", ctx)).toBeNull();
  });

  it("returns null when cache get throws", async () => {
    const ctx = {
      apiKey: "k",
      api: {} as CursorApiClient,
      cache: {
        get: vi.fn().mockRejectedValue(new Error("network")),
      } as unknown as DiskCache,
    };
    expect(await validateModelIdInCatalog("x", ctx)).toBeNull();
  });

  it("rejects id absent from non-empty catalog", async () => {
    const ctx = makeCtx([{ id: "a" }, { id: "b" }]);
    const msg = await validateModelIdInCatalog("zzz", ctx);
    expect(msg).toMatch(/Unknown model id/);
    expect(msg).toContain("/refresh models");
  });

  it("accepts id listed in catalog", async () => {
    const ctx = makeCtx([{ id: "a" }]);
    expect(await validateModelIdInCatalog("a", ctx)).toBeNull();
  });

  it("skips membership check when CURSOR_ORCH_ALLOW_UNKNOWN_MODEL=1", async () => {
    process.env[CURSOR_ORCH_ALLOW_UNKNOWN_MODEL_ENV] = "1";
    const ctx = makeCtx([{ id: "only" }]);
    expect(await validateModelIdInCatalog("foreign", ctx)).toBeNull();
  });
});

describe("cmdModelSlash", () => {
  afterEach(() => {
    delete process.env[CURSOR_ORCH_ALLOW_UNKNOWN_MODEL_ENV];
  });

  it("blocks unknown base id before apply when catalog is non-empty", async () => {
    const session = new Session();
    const ctx = makeCtx([{ id: "listed" }]);
    const out = await cmdModelSlash(session, "not-listed", undefined, ctx);
    expect(out).toMatch(/Unknown model id/);
    expect(session.config.model.id).toBe("");
  });

  it("allows unknown base id when escape hatch env is set", async () => {
    process.env[CURSOR_ORCH_ALLOW_UNKNOWN_MODEL_ENV] = "1";
    const session = new Session();
    const ctx = makeCtx([{ id: "listed" }]);
    const out = await cmdModelSlash(session, "raw-id", undefined, ctx);
    expect(out).toMatch(/Model set to/);
    expect(session.config.model.id).toBe("raw-id");
  });
});
