import { CursorApiClient } from "../../../api/cursor-api-client.js";
import { DiskCache } from "../../cache/disk-cache.js";

export type PickerContext = {
  api: CursorApiClient;
  cache: DiskCache;
  apiKey: string;
};

export const MODELS_TTL_MS = 24 * 60 * 60 * 1000;
export const REPOS_TTL_MS = 6 * 60 * 60 * 1000;
export const MODELS_CACHE_KEY = "models";
export const MODELS_CATALOG_CACHE_KEY = "models-catalog";
export const REPOS_CACHE_KEY = "repositories";

export function buildPickerContext(apiKey: string | undefined): PickerContext | null {
  if (!apiKey || !apiKey.trim()) {
    return null;
  }
  const trimmed = apiKey.trim();
  return {
    api: new CursorApiClient(trimmed),
    cache: new DiskCache(trimmed),
    apiKey: trimmed,
  };
}
