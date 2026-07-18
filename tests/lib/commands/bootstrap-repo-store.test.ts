import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepoStoreClient } from "../../../src/api/repo-store.js";
import {
  bootstrapEnvIssues,
  createBootstrapRepoStoreLoose,
} from "../../../src/lib/commands/bootstrap-repo-store.js";

const ENV_KEYS = ["GH_TOKEN", "BOOTSTRAP_OWNER", "BOOTSTRAP_REPO"] as const;

describe("bootstrapEnvIssues", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  it("returns null when GH_TOKEN, BOOTSTRAP_OWNER, and BOOTSTRAP_REPO are set", () => {
    process.env.GH_TOKEN = "ghp_test";
    process.env.BOOTSTRAP_OWNER = "owner";
    process.env.BOOTSTRAP_REPO = "repo";
    expect(bootstrapEnvIssues()).toBeNull();
  });

  it("reports missing or whitespace-only variables", () => {
    process.env.GH_TOKEN = "  ";
    process.env.BOOTSTRAP_OWNER = "owner";
    delete process.env.BOOTSTRAP_REPO;
    const msg = bootstrapEnvIssues()!;
    const missing = msg.match(/\(([^)]+)\)/)?.[1] ?? "";
    expect(missing).toContain("GH_TOKEN");
    expect(missing).toContain("BOOTSTRAP_REPO");
    expect(missing).not.toContain("BOOTSTRAP_OWNER");
  });
});

describe("createBootstrapRepoStoreLoose", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  it("returns null when bootstrap env is incomplete", () => {
    process.env.GH_TOKEN = "ghp_test";
    delete process.env.BOOTSTRAP_OWNER;
    process.env.BOOTSTRAP_REPO = "repo";
    expect(createBootstrapRepoStoreLoose()).toBeNull();
  });

  it("returns a RepoStoreClient when env is complete", () => {
    process.env.GH_TOKEN = "ghp_test";
    process.env.BOOTSTRAP_OWNER = "my-owner";
    process.env.BOOTSTRAP_REPO = "my-repo";
    const client = createBootstrapRepoStoreLoose();
    expect(client).toBeInstanceOf(RepoStoreClient);
  });
});
