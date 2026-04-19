import { describe, expect, it } from "vitest";
import {
  REQUIRED_SDK_PACKAGE,
  REQUIRED_SDK_SPEC,
  REQUIRED_SDK_VERSION,
  buildRuntimeDigest,
  createRuntimeMetadata,
  packageRuntimeSnapshot,
} from "../src/packager.js";

describe("packager", () => {
  it("includes runtime bundle and package.json", () => {
    const files = packageRuntimeSnapshot();
    expect(files["dist/orchestrator-runtime.cjs"]).toBeDefined();
    expect(files["package.json"]).toBeDefined();
  });

  it("digest stable for same files", () => {
    const files = {
      "src/orchestrator-entry.ts": "export {}\n",
    };
    const a = buildRuntimeDigest(files);
    const b = buildRuntimeDigest(files);
    expect(a).toBe(b);
  });

  it("exposes the required Cursor SDK version", () => {
    expect(REQUIRED_SDK_PACKAGE).toBe("@cursor/february");
    expect(REQUIRED_SDK_VERSION).toMatch(/^[\^~]?[0-9]+\.[0-9]+\.[0-9]+/);
    expect(REQUIRED_SDK_SPEC).toBe(`${REQUIRED_SDK_PACKAGE}@${REQUIRED_SDK_VERSION}`);
  });

  it("embeds sdk version into manifest at v3", () => {
    const files = { "package.json": "{}", "dist/orchestrator-runtime.cjs": "" };
    const manifest = createRuntimeMetadata(files);
    expect(manifest.version).toBe("3");
    expect(manifest.sdk_package).toBe(REQUIRED_SDK_PACKAGE);
    expect(manifest.sdk_version).toBe(REQUIRED_SDK_VERSION);
    expect(manifest.sdk_spec).toBe(REQUIRED_SDK_SPEC);
  });
});
