import type { ModelListItem } from "@cursor/sdk";
import { describe, expect, it, vi } from "vitest";
import { runModelAndVariantPicker, runModelPicker, type ModelPickerDeps, type ModelVariantPickerDeps } from "../../../src/lib/repl/pickers/model-picker.js";
import type { CacheResult } from "../../../src/lib/cache/disk-cache.js";
import { toSdkModelSelection } from "../../../src/lib/model-selection.js";

function makeDeps(overrides: Partial<ModelPickerDeps> = {}): { deps: ModelPickerDeps; logs: string[] } {
  const logs: string[] = [];
  const deps: ModelPickerDeps = {
    listCatalog: async () =>
      ({
        data: [
          { id: "composer-2", displayName: "Composer 2" },
          { id: "gpt-5.4", displayName: "GPT 5.4" },
        ],
        source: "fresh",
        fetchedAt: new Date(),
        error: null,
      }) satisfies CacheResult<ModelListItem[]>,
    pick: (async (items, _opts) => ({ kind: "selected", value: items[0]! })) as ModelPickerDeps["pick"],
    fallbackPrompt: async () => "manual-model",
    writeLine: (s) => logs.push(s),
    currentModel: "composer-2",
    isTTY: true,
    ...overrides,
  };
  return { deps, logs };
}

describe("runModelPicker", () => {
  it("returns selected model id from picker when fresh catalog available", async () => {
    const { deps } = makeDeps();
    const pick = vi.fn(deps.pick);
    deps.pick = pick as never;
    const r = await runModelPicker(deps);
    expect(r).toBe("composer-2");
    expect(pick).toHaveBeenCalled();
  });

  it("uses fallback prompt and prints dim warning when catalog returns none", async () => {
    const { deps, logs } = makeDeps({
      listCatalog: async () => ({ data: null, source: "none", fetchedAt: null, error: new Error("no key") }),
    });
    const r = await runModelPicker(deps);
    expect(r).toBe("manual-model");
    expect(logs.some((l) => l.includes("SDK model catalog unavailable"))).toBe(true);
  });

  it("uses fallback when catalog is empty array (fresh)", async () => {
    const { deps, logs } = makeDeps({
      listCatalog: async () => ({
        data: [],
        source: "fresh",
        fetchedAt: new Date(),
        error: null,
      }),
    });
    const r = await runModelPicker(deps);
    expect(r).toBe("manual-model");
    expect(logs.some((l) => l.includes("SDK model catalog unavailable"))).toBe(true);
  });

  it("prints stale warning when source is stale and still picks", async () => {
    const { deps, logs } = makeDeps({
      listCatalog: async () => ({
        data: [{ id: "composer-2", displayName: "Composer 2" }],
        source: "stale",
        fetchedAt: new Date(Date.now() - 90_000),
        error: new Error("down"),
      }),
    });
    const r = await runModelPicker(deps);
    expect(r).toBe("composer-2");
    expect(logs.some((l) => l.includes("Using stale model catalog"))).toBe(true);
  });

  it("returns null when picker is cancelled", async () => {
    const { deps } = makeDeps({ pick: (async () => ({ kind: "cancelled" })) as ModelPickerDeps["pick"] });
    const r = await runModelPicker(deps);
    expect(r).toBeNull();
  });

  it("passes currentModel as initial highlight when present in catalog", async () => {
    const spy = vi.fn(async (items: ModelListItem[], _opts: unknown) => ({ kind: "selected" as const, value: items[0]! }));
    const { deps } = makeDeps({ pick: spy as never, currentModel: "gpt-5.4" });
    await runModelPicker(deps);
    const call = spy.mock.calls[0];
    expect(call).toBeDefined();
    const opts = call![1] as { initialSelectedIndex?: number };
    expect(opts.initialSelectedIndex).toBe(1);
  });
});

describe("runModelAndVariantPicker", () => {
  it("returns id only when catalog entry has no variants", async () => {
    const deps: ModelVariantPickerDeps = {
      ...makeDeps().deps,
      listCatalog: async () => ({
        data: [{ id: "composer-2", displayName: "C" }],
        source: "fresh",
        fetchedAt: new Date(),
        error: null,
      }),
    };
    const r = await runModelAndVariantPicker(deps);
    expect(r).toEqual({ id: "composer-2" });
  });

  it("applies preset params when user picks a variant row", async () => {
    let call = 0;
    const pick = vi.fn(async (items: unknown[]) => {
      call++;
      if (call === 1) {
        return { kind: "selected" as const, value: items[0]! };
      }
      return { kind: "selected" as const, value: items[items.length - 1]! };
    });
    const deps: ModelVariantPickerDeps = {
      listCatalog: async () => ({
        data: [
          {
            id: "composer-2",
            displayName: "C",
            variants: [{ displayName: "Fast", params: [{ id: "thinking", value: "low" }] }],
          },
        ],
        source: "fresh",
        fetchedAt: new Date(),
        error: null,
      }),
      pick: pick as never,
      fallbackPrompt: async () => null,
      writeLine: () => {},
      currentModel: "composer-2",
      isTTY: true,
    };
    const r = await runModelAndVariantPicker(deps);
    expect(r).toEqual({ id: "composer-2", params: [{ id: "thinking", value: "low" }] });
    expect(toSdkModelSelection(r!)).toEqual({
      id: "composer-2",
      params: [{ id: "thinking", value: "low" }],
    });
  });

  it("persists canonical base id and preset params, never a composite slug id", async () => {
    let call = 0;
    const pick = vi.fn(async (items: unknown[]) => {
      call++;
      if (call === 1) {
        return { kind: "selected" as const, value: (items as ModelListItem[])[0]! };
      }
      return { kind: "selected" as const, value: items[items.length - 1]! };
    });
    const deps: ModelVariantPickerDeps = {
      listCatalog: async () => ({
        data: [
          {
            id: "gpt-5.5",
            displayName: "GPT-5.5",
            variants: [
              {
                displayName: "High",
                params: [
                  { id: "reasoning_effort", value: "high" },
                ],
              },
            ],
          },
        ],
        source: "fresh",
        fetchedAt: new Date(),
        error: null,
      }),
      pick: pick as never,
      fallbackPrompt: async () => null,
      writeLine: () => {},
      currentModel: "gpt-5.5",
      isTTY: true,
    };
    const r = await runModelAndVariantPicker(deps);
    expect(r).toEqual({
      id: "gpt-5.5",
      params: [{ id: "reasoning_effort", value: "high" }],
    });
    expect(r!.id).not.toMatch(/high$/);
    expect(toSdkModelSelection(r!)).toEqual({
      id: "gpt-5.5",
      params: [{ id: "reasoning_effort", value: "high" }],
    });
  });

  it("variant step disambiguates identical display names using params in the label", async () => {
    let pickCall = 0;
    const pick = vi.fn(async (items: unknown[], opts: { renderItem: (x: unknown) => string }) => {
      pickCall++;
      if (pickCall === 1) {
        return { kind: "selected" as const, value: (items as ModelListItem[])[0]! };
      }
      const labels = (items as unknown[]).map((row) => opts.renderItem(row));
      expect(labels[0]).toBe("Default (no preset)");
      expect(labels[1]).toBe("Composer 2 (thinking=low)");
      expect(labels[2]).toBe("Composer 2 (thinking=high)");
      return { kind: "selected" as const, value: (items as unknown[])[1]! };
    });
    const deps: ModelVariantPickerDeps = {
      listCatalog: async () => ({
        data: [
          {
            id: "composer-2",
            displayName: "Composer 2",
            variants: [
              { displayName: "Composer 2", params: [{ id: "thinking", value: "low" }] },
              { displayName: "Composer 2", params: [{ id: "thinking", value: "high" }] },
            ],
          },
        ],
        source: "fresh",
        fetchedAt: new Date(),
        error: null,
      }),
      pick: pick as never,
      fallbackPrompt: async () => null,
      writeLine: () => {},
      currentModel: "composer-2",
      isTTY: true,
    };
    const r = await runModelAndVariantPicker(deps);
    expect(r).toEqual({ id: "composer-2", params: [{ id: "thinking", value: "low" }] });
  });
});
