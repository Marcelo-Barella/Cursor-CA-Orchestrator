import { describe, expect, it } from "vitest";
import { formatRepoEquivalentCommand } from "../src/commands.js";
import {
  classifyRepoPositionalArgs,
  looksLikeUrlToken,
  needsRepoInteractive,
} from "../src/lib/repo-interactive.js";

describe("repo-interactive", () => {
  it("looksLikeUrlToken https and github.com", () => {
    expect(looksLikeUrlToken("https://github.com/o/r")).toBe(true);
    expect(looksLikeUrlToken("http://example.com/x")).toBe(true);
    expect(looksLikeUrlToken("git@github.com:o/r.git")).toBe(true);
    expect(looksLikeUrlToken("my-alias")).toBe(false);
    expect(looksLikeUrlToken("")).toBe(false);
  });

  it("classify zero args", () => {
    expect(classifyRepoPositionalArgs([])).toEqual({ alias: "", url: "", ref: "main" });
    expect(needsRepoInteractive([])).toBe(true);
  });

  it("classify one arg as URL", () => {
    expect(classifyRepoPositionalArgs(["https://github.com/a/b"])).toEqual({
      alias: "",
      url: "https://github.com/a/b",
      ref: "main",
    });
    expect(needsRepoInteractive(["https://github.com/a/b"])).toBe(true);
  });

  it("classify one arg as alias", () => {
    expect(classifyRepoPositionalArgs(["backend"])).toEqual({
      alias: "backend",
      url: "",
      ref: "main",
    });
    expect(needsRepoInteractive(["backend"])).toBe(true);
  });

  it("classify two args is complete", () => {
    expect(classifyRepoPositionalArgs(["a", "https://x"])).toEqual({
      alias: "a",
      url: "https://x",
      ref: "main",
    });
    expect(needsRepoInteractive(["a", "https://x"])).toBe(false);
  });

  it("classify three args includes ref", () => {
    expect(classifyRepoPositionalArgs(["a", "u", "develop"])).toEqual({
      alias: "a",
      url: "u",
      ref: "develop",
    });
    expect(needsRepoInteractive(["a", "u", "develop"])).toBe(false);
  });

  it("classify empty third ref falls back to main", () => {
    expect(classifyRepoPositionalArgs(["a", "u", ""])).toEqual({
      alias: "a",
      url: "u",
      ref: "main",
    });
  });

  it("formatRepoEquivalentCommand omits main ref", () => {
    expect(formatRepoEquivalentCommand("a", "https://x", "main")).toBe("/repo a https://x");
    expect(formatRepoEquivalentCommand("a", "https://x", "develop")).toBe("/repo a https://x develop");
  });
});
