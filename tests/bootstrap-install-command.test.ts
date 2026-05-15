import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { BOOTSTRAP_INSTALL_COMMAND } from "../src/bootstrap.js";

describe("BOOTSTRAP_INSTALL_COMMAND", () => {
  it("is a printf|base64|bash pipeline whose payload passes bash -n", () => {
    const m = BOOTSTRAP_INSTALL_COMMAND.match(/^printf '%s' (.+) \| base64 -d \| bash -l$/);
    expect(m, "expected printf '%s' <quoted-b64> | base64 -d | bash -l").toBeTruthy();
    const quoted = m![1]!;
    const b64 = JSON.parse(quoted) as string;
    const script = Buffer.from(b64, "base64").toString("utf8");
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("_try_install_with_resolved_toolchain");
    expect(script).toContain("apt-get install -y nodejs npm");
    execSync("bash -n", { input: script, stdio: ["pipe", "ignore", "pipe"] });
  });
});
