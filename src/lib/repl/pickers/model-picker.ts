import { tui } from "../../../tui/style.js";
import type { CacheResult } from "../../cache/disk-cache.js";
import type { PickOptions, PickResult } from "../list-picker.js";

export type ModelPickerDeps = {
  listModels: () => Promise<CacheResult<string[]>>;
  pick: (items: string[], opts: PickOptions<string>) => Promise<PickResult<string>>;
  fallbackPrompt: () => Promise<string | null>;
  writeLine: (line: string) => void;
  currentModel: string;
  isTTY: boolean;
};

function humanAge(d: Date): string {
  const ms = Date.now() - d.getTime();
  const s = Math.max(1, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export async function runModelPicker(deps: ModelPickerDeps): Promise<string | null> {
  const res = await deps.listModels();
  if (!res.data || res.data.length === 0) {
    deps.writeLine(tui.dim("Model list unavailable; enter value manually."));
    return deps.fallbackPrompt();
  }
  if (res.source === "stale" && res.fetchedAt) {
    deps.writeLine(tui.dim(`Using stale models cache (age: ${humanAge(res.fetchedAt)}).`));
  }
  const idx = res.data.indexOf(deps.currentModel);
  const picked = await deps.pick(res.data, {
    title: "Select model",
    renderItem: (s) => s,
    filterText: (s) => s,
    initialSelectedIndex: idx >= 0 ? idx : 0,
    isTTY: deps.isTTY,
  });
  if (picked.kind === "cancelled") {
    return null;
  }
  if ("value" in picked) {
    return picked.value;
  }
  return picked.values[0] ?? null;
}
