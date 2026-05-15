import type { ModelListItem, ModelVariant } from "@cursor/sdk";
import { tui } from "../../../tui/style.js";
import type { ModelParameterConfig, ModelSelectionConfig } from "../../../config/types.js";
import type { CacheResult } from "../../cache/disk-cache.js";
import { stableModelParamsKey } from "../../model-selection.js";
import type { PickOptions, PickResult } from "../list-picker.js";

export type ModelPickerBaseDeps = {
  pick: <T>(items: T[], opts: PickOptions<T>) => Promise<PickResult<T>>;
  fallbackPrompt: () => Promise<string | null>;
  writeLine: (line: string) => void;
  currentModel: string;
  isTTY: boolean;
};

export type ModelPickerDeps = ModelPickerBaseDeps & {
  listCatalog: () => Promise<CacheResult<ModelListItem[]>>;
};

export type ModelVariantPickerDeps = ModelPickerDeps & {
  currentModelParams?: ModelParameterConfig[];
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

type VariantRow = { tag: "default" } | { tag: "preset"; v: ModelVariant };

function variantRowLabel(v: ModelVariant): string {
  if (!v.params?.length) {
    return v.displayName;
  }
  const tail = v.params.map((p) => `${p.id}=${p.value}`).join(", ");
  return `${v.displayName} (${tail})`;
}

function variantFilterText(v: ModelVariant): string {
  const parts = [v.displayName, ...(v.params?.map((p) => `${p.id} ${p.value}`) ?? [])];
  return parts.join(" ");
}

function initialVariantRowIndex(entry: ModelListItem, current: ModelParameterConfig[] | undefined): number {
  const variants = entry.variants;
  if (!variants?.length) {
    return 0;
  }
  if (!current?.length) {
    const di = variants.findIndex((v) => v.isDefault);
    return di >= 0 ? di + 1 : 0;
  }
  const want = stableModelParamsKey(current);
  const vi = variants.findIndex((v) => stableModelParamsKey(v.params as ModelParameterConfig[]) === want);
  return vi >= 0 ? vi + 1 : 0;
}

function catalogModelRowLabel(m: ModelListItem): string {
  return `${m.displayName} ${tui.dim(`(${m.id})`)}`;
}

function catalogModelFilterText(m: ModelListItem): string {
  return `${m.displayName} ${m.id}`;
}

async function pickModelIdFromCatalogSnapshot(
  catRes: CacheResult<ModelListItem[]>,
  deps: ModelPickerBaseDeps,
): Promise<string | null> {
  const items = catRes.data;
  if (!items?.length) {
    deps.writeLine(
      tui.dim(
        "SDK model catalog unavailable (offline or error); enter a canonical model id manually. Prefer /refresh models when online.",
      ),
    );
    return deps.fallbackPrompt();
  }
  if (catRes.source === "stale" && catRes.fetchedAt) {
    deps.writeLine(tui.dim(`Using stale model catalog (age: ${humanAge(catRes.fetchedAt)}).`));
  }
  const idx = items.findIndex((m) => m.id === deps.currentModel);
  const picked = await deps.pick(items, {
    title: "Select model",
    renderItem: catalogModelRowLabel,
    filterText: catalogModelFilterText,
    initialSelectedIndex: idx >= 0 ? idx : 0,
    isTTY: deps.isTTY,
  });
  if (picked.kind === "cancelled") {
    return null;
  }
  const row: ModelListItem | undefined = "value" in picked ? picked.value : picked.values[0];
  return row?.id ?? null;
}

export async function runModelAndVariantPicker(deps: ModelVariantPickerDeps): Promise<ModelSelectionConfig | null> {
  const catRes = await deps.listCatalog();
  const pickedId = await pickModelIdFromCatalogSnapshot(catRes, deps);
  if (pickedId === null) {
    return null;
  }
  const entry = catRes.data?.find((m) => m.id === pickedId);
  if (!entry?.variants?.length) {
    return { id: pickedId };
  }
  const rows: VariantRow[] = [{ tag: "default" }, ...entry.variants.map((v) => ({ tag: "preset" as const, v }))];
  const initialSelectedIndex = Math.min(initialVariantRowIndex(entry, deps.currentModelParams), rows.length - 1);
  const vPick = await deps.pick(rows, {
    title: "Select variant",
    renderItem: (r) => (r.tag === "default" ? "Default (no preset)" : variantRowLabel(r.v)),
    filterText: (r) => (r.tag === "default" ? "default no preset" : variantFilterText(r.v)),
    initialSelectedIndex,
    isTTY: deps.isTTY,
  });
  if (vPick.kind === "cancelled") {
    return { id: pickedId };
  }
  const row: VariantRow | undefined = "value" in vPick ? vPick.value : vPick.values[0];
  if (!row || row.tag === "default") {
    return { id: pickedId };
  }
  return {
    id: pickedId,
    params: row.v.params.map((p) => ({ id: p.id, value: p.value })),
  };
}

export async function runModelPicker(deps: ModelPickerDeps): Promise<string | null> {
  const catRes = await deps.listCatalog();
  return pickModelIdFromCatalogSnapshot(catRes, deps);
}
