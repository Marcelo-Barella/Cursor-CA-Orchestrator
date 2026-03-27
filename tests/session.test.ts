import { describe, expect, it } from "vitest";
import { resolveSessionPaths, Session } from "../src/session.js";

describe("Session", () => {
  it("resetSessionToDefaults clears all config and setup state", () => {
    const session = new Session();
    session.setName("n");
    session.setModel("m");
    session.setPrompt("p");
    session.setBranchPrefix("other");
    session.setAutoPr(false);
    session.addRepo("a", "https://example.com/a.git");
    session.setBootstrapRepo("custom-bootstrap");
    session.setSetupState({ active: true, step: "prompt" });
    session.config.tasks.push({
      id: "t1",
      repo: "a",
      prompt: "x",
      model: null,
      depends_on: [],
      timeout_minutes: 30,
      create_repo: false,
      repo_config: null,
    });

    session.resetSessionToDefaults();

    const fresh = new Session();
    expect(session.config).toEqual(fresh.config);
    expect(session.setupState()).toEqual(fresh.setupState());
  });
});

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
