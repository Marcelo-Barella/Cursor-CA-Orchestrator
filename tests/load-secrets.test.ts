import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSecretsFromRepo } from "../src/orchestrator.js";

const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
}));

describe("loadSecretsFromRepo", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns GH_TOKEN and CURSOR_API_KEY from secrets.json", () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("git fetch")) return "";
      if (cmd.includes("secrets.json")) {
        return JSON.stringify({ GH_TOKEN: "ghp_x", CURSOR_API_KEY: "sk_x" });
      }
      throw new Error(`unexpected: ${cmd}`);
    });
    expect(loadSecretsFromRepo("run-1")).toEqual({
      GH_TOKEN: "ghp_x",
      CURSOR_API_KEY: "sk_x",
    });
    expect(execSyncMock).toHaveBeenCalledWith("git fetch origin run/run-1", { encoding: "utf8" });
  });

  it("throws when git fetch fails", () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("git fetch")) throw new Error("network down");
      throw new Error(`unexpected: ${cmd}`);
    });
    expect(() => loadSecretsFromRepo("run-1")).toThrow(/git fetch origin run\/run-1 failed/);
  });

  it("throws when secrets.json is missing", () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("git fetch")) return "";
      if (cmd.includes("secrets.json")) throw new Error("path not in tree");
      throw new Error(`unexpected: ${cmd}`);
    });
    expect(() => loadSecretsFromRepo("run-1")).toThrow(/git show FETCH_HEAD:secrets.json failed/);
  });

  it("throws when secrets.json is not valid JSON", () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("git fetch")) return "";
      if (cmd.includes("secrets.json")) return "{not-json";
      throw new Error(`unexpected: ${cmd}`);
    });
    expect(() => loadSecretsFromRepo("run-1")).toThrow(/secrets.json is not valid JSON/);
  });

  it("throws when secrets.json is not an object", () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("git fetch")) return "";
      if (cmd.includes("secrets.json")) return JSON.stringify(["array"]);
      throw new Error(`unexpected: ${cmd}`);
    });
    expect(() => loadSecretsFromRepo("run-1")).toThrow(/must be a JSON object/);
  });

  it("throws when GH_TOKEN or CURSOR_API_KEY is missing or empty", () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("git fetch")) return "";
      if (cmd.includes("secrets.json")) return JSON.stringify({ GH_TOKEN: "", CURSOR_API_KEY: "sk_x" });
      throw new Error(`unexpected: ${cmd}`);
    });
    expect(() => loadSecretsFromRepo("run-1")).toThrow(/missing or empty GH_TOKEN/);

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes("git fetch")) return "";
      if (cmd.includes("secrets.json")) return JSON.stringify({ GH_TOKEN: "ghp_x" });
      throw new Error(`unexpected: ${cmd}`);
    });
    expect(() => loadSecretsFromRepo("run-1")).toThrow(/missing or empty CURSOR_API_KEY/);
  });
});
