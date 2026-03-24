import { describe, expect, it } from "vitest";
import { extractSlashQueryPrefix, shouldShowSlashSuggestions } from "../src/lib/repl/tty-line-editor.js";

describe("tty-line-editor slash gate", () => {
  it("shows suggestions for slash only or slash plus spaces before cursor", () => {
    expect(shouldShowSlashSuggestions("/", 1)).toBe(true);
    expect(shouldShowSlashSuggestions("  /   ", 6)).toBe(true);
  });

  it("hides after a space inside the command segment", () => {
    expect(shouldShowSlashSuggestions("/repo ", 6)).toBe(false);
  });

  it("extracts prefix for filtering", () => {
    expect(extractSlashQueryPrefix("/pro", 4)).toBe("pro");
    expect(extractSlashQueryPrefix("/  pro", 6)).toBe("pro");
  });
});
