import { describe, expect, it, vi } from "vitest";
import { runModelPicker, type ModelPickerDeps } from "../../../src/lib/repl/pickers/model-picker.js";
import type { CacheResult } from "../../../src/lib/cache/disk-cache.js";

function makeDeps(overrides: Partial<ModelPickerDeps> = {}): { deps: ModelPickerDeps; logs: string[] } {
  const logs: string[] = [];
  const deps: ModelPickerDeps = {
    listModels: async () => ({ data: ["composer-2", "gpt-5.4"], source: "fresh", fetchedAt: new Date(), error: null }) satisfies CacheResult<string[]>,
    pick: async (items, _opts) => ({ kind: "selected", value: items[0]! }),
    fallbackPrompt: async () => "manual-model",
    writeLine: (s) => logs.push(s),
    currentModel: "composer-2",
    isTTY: true,
    ...overrides,
  };
  return { deps, logs };
}

describe("runModelPicker", () => {
  it("returns selected model from picker when fresh cache available", async () => {
    const { deps } = makeDeps();
    const pick = vi.fn(deps.pick);
    deps.pick = pick;
    const r = await runModelPicker(deps);
    expect(r).toBe("composer-2");
    expect(pick).toHaveBeenCalled();
  });

  it("uses fallback prompt and prints dim warning when listModels returns none", async () => {
    const { deps, logs } = makeDeps({
      listModels: async () => ({ data: null, source: "none", fetchedAt: null, error: new Error("no key") }),
    });
    const r = await runModelPicker(deps);
    expect(r).toBe("manual-model");
    expect(logs.some((l) => l.includes("Model list unavailable"))).toBe(true);
  });

  it("prints stale warning when source is stale and still picks", async () => {
    const { deps, logs } = makeDeps({
      listModels: async () => ({ data: ["composer-2"], source: "stale", fetchedAt: new Date(Date.now() - 90_000), error: new Error("down") }),
    });
    const r = await runModelPicker(deps);
    expect(r).toBe("composer-2");
    expect(logs.some((l) => l.includes("Using stale models cache"))).toBe(true);
  });

  it("returns null when picker is cancelled", async () => {
    const { deps } = makeDeps({ pick: async () => ({ kind: "cancelled" }) });
    const r = await runModelPicker(deps);
    expect(r).toBeNull();
  });

  it("passes currentModel as initial highlight when present in list", async () => {
    const spy = vi.fn<ModelPickerDeps["pick"]>(async (items) => ({ kind: "selected" as const, value: items[0]! }));
    const { deps } = makeDeps({ pick: spy, currentModel: "gpt-5.4" });
    await runModelPicker(deps);
    const opts = spy.mock.calls[0]![1] as { initialSelectedIndex?: number };
    expect(opts.initialSelectedIndex).toBe(1);
  });
});
