import { describe, expect, it } from "vitest";
import {
  buildRepoTokenIndex,
  extractRepoName,
  looksLikeGithubRepoHttpsUrl,
  normalizeRepoToken,
  resolveRepoTarget,
} from "../src/lib/repo-target.js";

describe("normalizeRepoToken", () => {
  it("trims, strips trailing slashes and .git, and lowercases", () => {
    expect(normalizeRepoToken("  HTTPS://GitHub.com/Acme/Widget.git/  ")).toBe(
      "https://github.com/acme/widget",
    );
  });
});

describe("extractRepoName", () => {
  it("returns the last path segment", () => {
    expect(extractRepoName("https://github.com/o/my-repo")).toBe("my-repo");
    expect(extractRepoName("alias-name")).toBe("alias-name");
  });
});

describe("looksLikeGithubRepoHttpsUrl", () => {
  it("accepts github https URLs with owner and repo", () => {
    expect(looksLikeGithubRepoHttpsUrl("https://github.com/o/r")).toBe(true);
    expect(looksLikeGithubRepoHttpsUrl("owner/repo")).toBe(false);
  });
});

describe("buildRepoTokenIndex", () => {
  it("maps normalized URL and repo name tokens to aliases", () => {
    const index = buildRepoTokenIndex({
      svc: { url: "https://github.com/acme/svc", ref: "main" },
    });
    expect([...index.get("https://github.com/acme/svc")!]).toEqual(["svc"]);
    expect([...index.get("svc")!]).toEqual(["svc"]);
  });

  it("allows multiple aliases for the same token when ambiguous", () => {
    const index = buildRepoTokenIndex({
      a: { url: "https://github.com/o/shared", ref: "main" },
      b: { url: "https://github.com/o/shared", ref: "develop" },
    });
    const matches = index.get("https://github.com/o/shared");
    expect(matches?.size).toBe(2);
  });
});

describe("resolveRepoTarget", () => {
  const repos = {
    backend: { url: "https://github.com/acme/backend", ref: "main" },
    frontend: { url: "acme/frontend", ref: "develop" },
  };

  it("returns https URLs unchanged with fallback ref", () => {
    expect(resolveRepoTarget("https://github.com/acme/other", repos, "main")).toEqual([
      "https://github.com/acme/other",
      "main",
    ]);
  });

  it("expands owner/repo shorthand to https URL", () => {
    expect(resolveRepoTarget("acme/widget", repos, "main")).toEqual([
      "https://github.com/acme/widget",
      "main",
    ]);
  });

  it("resolves repository alias to canonical URL and alias ref", () => {
    expect(resolveRepoTarget("backend", repos, "main")).toEqual([
      "https://github.com/acme/backend",
      "main",
    ]);
  });

  it("follows alias chains through owner/repo shorthand", () => {
    expect(resolveRepoTarget("frontend", repos, "main")).toEqual([
      "https://github.com/acme/frontend",
      "develop",
    ]);
  });

  it("resolves unique token match when alias key is a GitHub URL", () => {
    expect(resolveRepoTarget("bergamota", repos, "main")).toBeNull();
    expect(
      resolveRepoTarget("bergamota", {
        "https://github.com/o/bergamota.git": { url: "https://github.com/o/bergamota.git", ref: "main" },
      }, "main"),
    ).toEqual(["https://github.com/o/bergamota.git", "main"]);
  });

  it("returns null for empty input", () => {
    expect(resolveRepoTarget("", repos, "main")).toBeNull();
  });

  it("returns null when token matches multiple aliases", () => {
    expect(
      resolveRepoTarget("shared", {
        a: { url: "https://github.com/o/shared", ref: "main" },
        b: { url: "https://github.com/o/shared", ref: "develop" },
      }, "main"),
    ).toBeNull();
  });

  it("returns null on alias cycles", () => {
    expect(
      resolveRepoTarget("a", {
        a: { url: "b", ref: "main" },
        b: { url: "a", ref: "main" },
      }, "main"),
    ).toBeNull();
  });

  it("returns null for unknown tokens", () => {
    expect(resolveRepoTarget("missing", repos, "main")).toBeNull();
  });
});
