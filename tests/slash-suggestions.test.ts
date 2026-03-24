import { describe, expect, it } from "vitest";
import { filterSlashSuggestions, getAllSlashSuggestions } from "../src/lib/repl/slash-suggestions.js";

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
});
