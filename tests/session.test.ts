import { describe, expect, it } from "vitest";
import { resolveSessionPaths } from "../src/session.js";

describe("session storage isolation", () => {
  it("namespaces session files by workspace path", () => {
    const alpha = resolveSessionPaths({
      homeDir: "/home/dev",
      cwd: "/workspaces/alpha",
    });
    const beta = resolveSessionPaths({
      homeDir: "/home/dev",
      cwd: "/workspaces/beta",
    });

    expect(alpha.sessionPath).not.toBe(beta.sessionPath);
    expect(alpha.setupStatePath).not.toBe(beta.setupStatePath);
    expect(alpha.historyPath).not.toBe(beta.historyPath);
  });

  it("uses the explicit session key across workspaces", () => {
    const left = resolveSessionPaths({
      homeDir: "/home/dev",
      cwd: "/workspaces/alpha",
      sessionKey: "shared",
    });
    const right = resolveSessionPaths({
      homeDir: "/home/dev",
      cwd: "/workspaces/beta",
      sessionKey: "shared",
    });

    expect(left.sessionPath).toBe(right.sessionPath);
    expect(left.historyPath).toBe(right.historyPath);
  });
});
