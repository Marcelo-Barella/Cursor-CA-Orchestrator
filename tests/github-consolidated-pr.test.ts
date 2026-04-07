import { describe, expect, it } from "vitest";
import { groupKeyForRepo, integrationBranchName, topoSortTaskGroup } from "../src/lib/github-consolidated-pr.js";
import { parseGithubOwnerRepo } from "../src/lib/repo-target.js";

describe("topoSortTaskGroup", () => {
  it("orders dependencies before dependents", () => {
    const graph: Record<string, Set<string>> = {
      a: new Set(),
      b: new Set(["a"]),
      c: new Set(["b"]),
    };
    expect(topoSortTaskGroup(["c", "a", "b"], graph)).toEqual(["a", "b", "c"]);
  });

  it("throws on cycle", () => {
    const graph: Record<string, Set<string>> = {
      a: new Set(["b"]),
      b: new Set(["a"]),
    };
    expect(() => topoSortTaskGroup(["a", "b"], graph)).toThrow(/cycle/);
  });
});

describe("integrationBranchName", () => {
  it("includes sanitized base ref", () => {
    expect(integrationBranchName("p", "run1", "main")).toBe("p/run1/main/consolidated");
  });
});

describe("groupKeyForRepo", () => {
  it("joins normalized url and ref", () => {
    const k = groupKeyForRepo("https://github.com/O/R.git", "main");
    expect(k).toContain("github.com/o/r");
    expect(k.endsWith("\0main")).toBe(true);
  });
});

describe("parseGithubOwnerRepo", () => {
  it("parses https owner and repo", () => {
    expect(parseGithubOwnerRepo("https://github.com/acme/widget")).toEqual({ owner: "acme", repo: "widget" });
  });
});
