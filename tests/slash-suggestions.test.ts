import { describe, expect, it } from "vitest";
import {
  filterSlashSuggestions,
  getAllSlashSuggestions,
  longestCommonStemPrefix,
  replaceSlashQuerySegment,
  rotateSlashHighlight,
} from "../src/lib/repl/slash-suggestions.js";

describe("slash-suggestions", () => {
  it("empty prefix returns all commands sorted by label", () => {
    const all = filterSlashSuggestions("");
    const labels = all.map((e) => e.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    expect(labels.length).toBe(getAllSlashSuggestions().length);
    expect(all.length).toBeGreaterThan(0);
  });

  it("single match for distinctive prefix", () => {
    const m = filterSlashSuggestions("help");
    expect(m.map((e) => e.dispatchKey)).toEqual(["help"]);
  });

  it("multi match for shared prefix", () => {
    const m = filterSlashSuggestions("re");
    const keys = m.map((e) => e.dispatchKey).sort();
    expect(keys).toContain("repo");
    expect(keys).toContain("repo-remove");
    expect(keys).toContain("repos");
  });

  it("no match returns empty", () => {
    expect(filterSlashSuggestions("zzznope")).toEqual([]);
  });

  it("prefix match is case-insensitive", () => {
    const lower = filterSlashSuggestions("pro");
    const upper = filterSlashSuggestions("PRO");
    expect(lower.map((e) => e.dispatchKey)).toEqual(upper.map((e) => e.dispatchKey));
    expect(lower.map((e) => e.dispatchKey)).toContain("prompt");
    expect(lower.map((e) => e.dispatchKey)).toContain("prompt-set");
  });

  it("includes /repo remove alias for repo-remove", () => {
    const m = filterSlashSuggestions("repo");
    const labels = m.map((e) => e.label);
    expect(labels.some((l) => l.includes("repo remove"))).toBe(true);
    const rm = m.find((e) => e.label.includes("repo remove"));
    expect(rm?.dispatchKey).toBe("repo-remove");
  });

  it("longestCommonStemPrefix for shared prefix", () => {
    const m = filterSlashSuggestions("re");
    const lcp = longestCommonStemPrefix(m);
    expect(lcp.toLowerCase()).toBe("repo");
  });

  it("replaceSlashQuerySegment updates query and cursor", () => {
    const r = replaceSlashQuerySegment("/pr", 3, "prompt");
    expect(r).toEqual({ line: "/prompt", cursor: "/prompt".length });
    const r2 = replaceSlashQuerySegment("  /  x", 6, "help");
    expect(r2?.line).toBe("  /  help");
    expect(r2?.cursor).toBe(9);
  });

  it("rotateSlashHighlight wraps and is no-op for single match", () => {
    expect(rotateSlashHighlight(0, 1, "down")).toBe(0);
    expect(rotateSlashHighlight(2, 3, "down")).toBe(0);
    expect(rotateSlashHighlight(0, 3, "up")).toBe(2);
    expect(rotateSlashHighlight(1, 3, "up")).toBe(0);
  });
});
