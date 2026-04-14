import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  envValueMissing,
  getRequiredEnvKeysForCliArgs,
  mergeDotenvUpdates,
  peelSubcommandTokens,
} from "../src/lib/env-wizard.js";

describe("peelSubcommandTokens", () => {
  it("collects command tokens and skips flags and values", () => {
    expect(peelSubcommandTokens(["status", "--run", "abc"])).toEqual(["status"]);
    expect(peelSubcommandTokens(["run", "--config", "./c.yaml", "--bootstrap-repo", "b"])).toEqual(["run"]);
    expect(peelSubcommandTokens(["logs", "-r", "id"])).toEqual(["logs"]);
  });

  it("stops at --", () => {
    expect(peelSubcommandTokens(["run", "--", "--config", "x"])).toEqual(["run"]);
  });
});

describe("getRequiredEnvKeysForCliArgs", () => {
  it("returns null for help and version", () => {
    expect(getRequiredEnvKeysForCliArgs(["--help"])).toBeNull();
    expect(getRequiredEnvKeysForCliArgs(["status", "--help"])).toBeNull();
    expect(getRequiredEnvKeysForCliArgs(["-v"])).toBeNull();
  });

  it("maps subcommands to required keys", () => {
    expect(getRequiredEnvKeysForCliArgs(["run", "--config", "x"])).toEqual(["CURSOR_API_KEY", "GH_TOKEN"]);
    expect(getRequiredEnvKeysForCliArgs(["status", "--run", "x"])).toEqual([
      "GH_TOKEN",
      "BOOTSTRAP_OWNER",
      "BOOTSTRAP_REPO",
    ]);
    expect(getRequiredEnvKeysForCliArgs(["logs", "--run", "x"])).toEqual([
      "CURSOR_API_KEY",
      "GH_TOKEN",
      "BOOTSTRAP_OWNER",
      "BOOTSTRAP_REPO",
    ]);
    expect(getRequiredEnvKeysForCliArgs(["stop", "--run", "x"])).toEqual([
      "GH_TOKEN",
      "BOOTSTRAP_OWNER",
      "BOOTSTRAP_REPO",
    ]);
    expect(getRequiredEnvKeysForCliArgs(["cleanup"])).toEqual([
      "GH_TOKEN",
      "BOOTSTRAP_OWNER",
      "BOOTSTRAP_REPO",
    ]);
    expect(getRequiredEnvKeysForCliArgs(["config", "doctor"])).toBeNull();
    expect(getRequiredEnvKeysForCliArgs(["unknown"])).toBeNull();
  });
});

describe("mergeDotenvUpdates", () => {
  it("creates file and writes keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-env-"));
    const p = path.join(dir, ".env");
    mergeDotenvUpdates(p, { BOOTSTRAP_OWNER: "acme", GH_TOKEN: "abc" });
    const text = fs.readFileSync(p, "utf8");
    expect(text).toContain("BOOTSTRAP_OWNER=acme");
    expect(text).toContain("GH_TOKEN=abc");
  });

  it("replaces existing keys and keeps other lines", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-env-"));
    const p = path.join(dir, ".env");
    fs.writeFileSync(p, "# c\nFOO=1\nBOOTSTRAP_OWNER=old\n", "utf8");
    mergeDotenvUpdates(p, { BOOTSTRAP_OWNER: "new", BAR: "x y" });
    const text = fs.readFileSync(p, "utf8");
    expect(text).toContain("# c");
    expect(text).toContain("FOO=1");
    expect(text).not.toContain("BOOTSTRAP_OWNER=old");
    expect(text).toContain('BOOTSTRAP_OWNER=new');
    expect(text).toMatch(/BAR="x y"/);
  });
});

describe("envValueMissing", () => {
  it("treats empty and whitespace as missing", () => {
    const prev = process.env._TEST_ORCH_X;
    delete process.env._TEST_ORCH_X;
    expect(envValueMissing("_TEST_ORCH_X")).toBe(true);
    process.env._TEST_ORCH_X = "";
    expect(envValueMissing("_TEST_ORCH_X")).toBe(true);
    process.env._TEST_ORCH_X = "  ";
    expect(envValueMissing("_TEST_ORCH_X")).toBe(true);
    process.env._TEST_ORCH_X = "ok";
    expect(envValueMissing("_TEST_ORCH_X")).toBe(false);
    if (prev === undefined) {
      delete process.env._TEST_ORCH_X;
    } else {
      process.env._TEST_ORCH_X = prev;
    }
  });
});
