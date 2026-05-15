import type { ModelListItem } from "@cursor/sdk";
import type { ModelParameterConfig, ModelSelectionConfig } from "../config/types.js";

export function normalizeModelFromYaml(raw: unknown, fallbackId = "composer-2"): ModelSelectionConfig {
  if (raw === undefined || raw === null) {
    return { id: fallbackId };
  }
  if (typeof raw === "string") {
    return { id: raw.trim() || fallbackId };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("model must be a string or a mapping with id");
  }
  const o = raw as Record<string, unknown>;
  const id = String(o.id ?? "").trim() || fallbackId;
  const paramsRaw = o.params;
  const params = Array.isArray(paramsRaw)
    ? paramsRaw.map((p) => {
        if (typeof p !== "object" || p === null) throw new Error("each model.params entry must be an object");
        const q = p as Record<string, unknown>;
        return { id: String(q.id ?? ""), value: String(q.value ?? "") };
      })
    : undefined;
  return params?.length ? { id, params } : { id };
}

export function toSdkModelSelection(m: ModelSelectionConfig): { id: string; params?: { id: string; value: string }[] } {
  const out: { id: string; params?: { id: string; value: string }[] } = { id: m.id };
  if (m.params?.length) {
    out.params = m.params.map((p) => ({ id: p.id, value: p.value }));
  }
  return out;
}

export function formatModelSummary(m: ModelSelectionConfig): string {
  if (!m.params?.length) return m.id;
  const tail = m.params.map((p) => `${p.id}=${p.value}`).join(", ");
  return `${m.id} (${tail})`;
}

export function stableModelParamsKey(params: ModelParameterConfig[]): string {
  return JSON.stringify(
    [...params].map((p) => ({ id: p.id, value: p.value })).sort((a, b) => a.id.localeCompare(b.id)),
  );
}

export function equivalentModelSlashCommand(
  sel: ModelSelectionConfig,
  catalog: ModelListItem[] | null | undefined,
): string {
  const id = sel.id;
  if (!sel.params?.length) {
    return `/model ${id}`;
  }
  const want = stableModelParamsKey(sel.params);
  const entry = catalog?.find((m) => m.id === id);
  if (entry?.variants) {
    for (const v of entry.variants) {
      if (stableModelParamsKey(v.params as ModelParameterConfig[]) === want) {
        const d = v.displayName.trim();
        return `/model ${id} ${/\s/.test(d) ? JSON.stringify(d) : d}`;
      }
    }
  }
  return `/model ${id}`;
}

export function matchVariantParamsByDisplayName(
  modelId: string,
  token: string,
  catalog: ModelListItem[] | null | undefined,
): { params: ModelParameterConfig[] } | { error: string } {
  const t = token.trim().toLowerCase();
  if (!t) {
    return { error: "Variant name cannot be empty." };
  }
  if (!catalog?.length) {
    return { error: "Model catalog unavailable; set CURSOR_API_KEY and try /refresh models." };
  }
  const entry = catalog.find((m) => m.id === modelId);
  if (!entry) {
    return { error: `Model "${modelId}" not found in catalog.` };
  }
  const variants = entry.variants;
  if (!variants?.length) {
    return { error: `Model "${modelId}" has no preset variants in the catalog.` };
  }
  const match = variants.find((v) => v.displayName.trim().toLowerCase() === t);
  if (!match) {
    const names = variants.map((v) => v.displayName).join(", ");
    return { error: `Unknown variant "${token}" for ${modelId}. Presets: ${names}` };
  }
  return { params: match.params.map((p) => ({ id: p.id, value: p.value })) };
}
