import { CursorApiClient } from "../../../api/cursor-api-client.js";
import { DiskCache } from "../../cache/disk-cache.js";

export type PickerContext = {
  api: CursorApiClient;
  cache: DiskCache;
};

export const MODELS_TTL_MS = 24 * 60 * 60 * 1000;
export const REPOS_TTL_MS = 6 * 60 * 60 * 1000;
export const MODELS_CACHE_KEY = "models";
export const REPOS_CACHE_KEY = "repositories";

export function buildPickerContext(apiKey: string | undefined): PickerContext | null {
  if (!apiKey || !apiKey.trim()) {
    return null;
  }
  return {
    api: new CursorApiClient(apiKey.trim()),
    cache: new DiskCache(apiKey.trim()),
  };
}
