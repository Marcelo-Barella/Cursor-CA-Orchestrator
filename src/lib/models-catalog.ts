import type { ModelListItem } from "@cursor/sdk";

export async function fetchModelsCatalog(apiKey: string): Promise<ModelListItem[]> {
  const key = apiKey.trim();
  if (!key) {
    throw new Error("CURSOR_API_KEY is required to list models catalog");
  }
  const { Cursor } = await import("@cursor/sdk");
  return Cursor.models.list({ apiKey: key });
}
