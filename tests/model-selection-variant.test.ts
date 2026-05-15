import type { ModelListItem } from "@cursor/sdk";
import { describe, expect, it } from "vitest";
import {
  equivalentModelSlashCommand,
  matchVariantParamsByDisplayName,
  toSdkModelSelection,
} from "../src/lib/model-selection.js";

const catalog: ModelListItem[] = [
  {
    id: "composer-2",
    displayName: "Composer 2",
    variants: [
      { displayName: "Fast", params: [{ id: "thinking", value: "low" }] },
      { displayName: "Slow", params: [{ id: "thinking", value: "high" }] },
    ],
  },
];

describe("matchVariantParamsByDisplayName", () => {
  it("matches preset case-insensitively", () => {
    const r = matchVariantParamsByDisplayName("composer-2", "fast", catalog);
    expect("params" in r && r.params).toEqual([{ id: "thinking", value: "low" }]);
  });

  it("errors on unknown variant", () => {
    const r = matchVariantParamsByDisplayName("composer-2", "nope", catalog);
    expect("error" in r && r.error).toMatch(/Unknown variant/);
  });

  it("errors when catalog is empty array", () => {
    const r = matchVariantParamsByDisplayName("composer-2", "fast", []);
    expect("error" in r && r.error).toMatch(/catalog unavailable/);
  });
});

describe("equivalentModelSlashCommand", () => {
  it("uses id only when no params", () => {
    expect(equivalentModelSlashCommand({ id: "composer-2" }, catalog)).toBe("/model composer-2");
  });

  it("includes variant label when params match a preset", () => {
    expect(
      equivalentModelSlashCommand(
        { id: "composer-2", params: [{ id: "thinking", value: "low" }] },
        catalog,
      ),
    ).toBe("/model composer-2 Fast");
  });

  it("uses base id only when params are not a catalog preset (no composite slug)", () => {
    expect(
      equivalentModelSlashCommand(
        { id: "composer-2", params: [{ id: "thinking", value: "medium" }] },
        catalog,
      ),
    ).toBe("/model composer-2");
  });
});

describe("toSdkModelSelection", () => {
  it("keeps base model id and optional params", () => {
    expect(toSdkModelSelection({ id: "gpt-5.5", params: [{ id: "reasoning_effort", value: "high" }] })).toEqual({
      id: "gpt-5.5",
      params: [{ id: "reasoning_effort", value: "high" }],
    });
  });
});
