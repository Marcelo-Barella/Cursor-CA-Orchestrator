import { describe, expect, it } from "vitest";
import { claimsOverlap, findClaimOverlaps, normalizeClaimPath } from "../../src/engine/claims.js";
import type { TaskConfig } from "../../src/config/types.js";

function task(id: string, paths: string[]): TaskConfig {
  return {
    id,
    repo: "svc",
    prompt: "x",
    model: null,
    depends_on: [],
    timeout_minutes: 30,
    create_repo: false,
    repo_config: null,
    allowed_paths: paths,
  };
}

describe("claims", () => {
  it("normalizes trailing slashes", () => {
    expect(normalizeClaimPath("src/api/")).toBe("src/api");
  });

  it("detects prefix overlap", () => {
    expect(claimsOverlap("src/api", "src/api/routes.ts")).toBe(true);
    expect(claimsOverlap("src/api", "src/web")).toBe(false);
  });

  it("treats '.' as whole-repo overlap", () => {
    expect(claimsOverlap(".", "src/foo.ts")).toBe(true);
    expect(claimsOverlap("src/foo.ts", ".")).toBe(true);
    expect(claimsOverlap(".", ".")).toBe(true);
    expect(claimsOverlap("./", "src/web")).toBe(true);
    expect(claimsOverlap("", "src/foo.ts")).toBe(false);
  });

  it("finds overlaps when one task claims '.'", () => {
    const overlaps = findClaimOverlaps([
      task("pathful", ["src/foo.ts"]),
      task("pathless", ["."]),
    ]);
    expect(overlaps).toEqual([
      { left: "pathful", right: "pathless", pathA: "src/foo.ts", pathB: "." },
    ]);
  });

  it("finds overlapping tasks", () => {
    const overlaps = findClaimOverlaps([
      task("a", ["src/api"]),
      task("b", ["src/api/handlers"]),
      task("c", ["src/web"]),
    ]);
    expect(overlaps).toEqual([
      { left: "a", right: "b", pathA: "src/api", pathB: "src/api/handlers" },
    ]);
  });

  it("ignores create_repo tasks without paths", () => {
    const create: TaskConfig = {
      ...task("new", []),
      create_repo: true,
      repo: "__new__",
    };
    expect(findClaimOverlaps([create, task("a", ["src"])])).toEqual([]);
  });
});
