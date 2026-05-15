import { describe, expect, it, vi } from "vitest";

vi.mock("@cursor/sdk", () => ({
  Cursor: {
    models: {
      list: vi.fn().mockResolvedValue([{ id: "x", displayName: "X" }]),
    },
  },
}));

import { Cursor } from "@cursor/sdk";
import { fetchModelsCatalog } from "../src/lib/models-catalog.js";

describe("fetchModelsCatalog", () => {
  it("invokes Cursor.models.list with trimmed api key", async () => {
    vi.mocked(Cursor.models.list).mockClear();
    const rows = await fetchModelsCatalog(" sk-test ");
    expect(rows).toHaveLength(1);
    expect(vi.mocked(Cursor.models.list)).toHaveBeenCalledWith({ apiKey: "sk-test" });
  });

  it("throws when api key empty", async () => {
    await expect(fetchModelsCatalog("  ")).rejects.toThrow(/CURSOR_API_KEY/);
  });
});
