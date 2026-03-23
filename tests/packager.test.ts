import { describe, expect, it } from "vitest";
import { buildRuntimeDigest, packageRuntimeSnapshot } from "../src/packager.js";

describe("packager", () => {
  it("includes runtime bundle and package.json", () => {
    const files = packageRuntimeSnapshot();
    expect(files["dist/orchestrator-runtime.cjs"]).toBeDefined();
    expect(files["package.json"]).toBeDefined();
  });

  it("digest stable for same files", () => {
    const files = {
      "src/cursor_orch/orchestrator.py": "print('a')\n",
    };
    const a = buildRuntimeDigest(files);
    const b = buildRuntimeDigest(files);
    expect(a).toBe(b);
  });
});
