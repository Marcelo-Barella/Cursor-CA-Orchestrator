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
    expect(lower.map((e) => e.dispatchKey)).toContain("prompt-set");
  });

  it("includes /repo remove alias for repo-remove", () => {
    const m = filterSlashSuggestions("repo");
    const labels = m.map((e) => e.label);
    expect(labels.some((l) => l.includes("repo remove"))).toBe(true);
    const rm = m.find((e) => e.label.includes("repo remove"));
    expect(rm?.dispatchKey).toBe("repo-remove");
  });

  it("includes /config clear for config", () => {
    const m = filterSlashSuggestions("config");
    const labels = m.map((e) => e.label);
    expect(labels.some((l) => l.includes("config clear"))).toBe(true);
    const cl = m.find((e) => e.label.includes("config clear"));
    expect(cl?.dispatchKey).toBe("config");
  });

  it("includes /mcp and its subcommand aliases", () => {
    const m = filterSlashSuggestions("mcp");
    const labels = m.map((e) => e.label);
    expect(labels).toContain("/mcp");
    expect(labels).toContain("/mcp list");
    expect(labels).toContain("/mcp import");
    expect(labels).toContain("/mcp remove");
    expect(labels).toContain("/mcp clear");
    for (const entry of m) {
      expect(entry.dispatchKey).toBe("mcp");
    }
  });

  it("longestCommonStemPrefix for shared prefix", () => {
    const m = filterSlashSuggestions("rep");
    const lcp = longestCommonStemPrefix(m);
    expect(lcp.toLowerCase()).toBe("repo");
  });

  it("replaceSlashQuerySegment updates query and cursor", () => {
    const r = replaceSlashQuerySegment("/mo", 3, "model");
    expect(r).toEqual({ line: "/model", cursor: "/model".length });
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

  it("includes /mcp add suggestion row with correct dispatch key and usage", () => {
    const m = filterSlashSuggestions("mcp");
    const labels = m.map((e) => e.label);
    expect(labels).toContain("/mcp add");
    const add = m.find((e) => e.label === "/mcp add");
    expect(add?.dispatchKey).toBe("mcp");
    expect(add?.usage).toBe("/mcp add");
    expect(add?.description).toMatch(/paste|Cursor/i);
  });

  it("/mcp add is the only match for the 'mcp a' prefix", () => {
    const m = filterSlashSuggestions("mcp a");
    expect(m.map((e) => e.label)).toEqual(["/mcp add"]);
  });
});
