import { describe, expect, it } from "vitest";
import { reserveRunId } from "../src/lib/commands/run-impl.js";

describe("run id reservation", () => {
  it("retries until it reserves a fresh run id", async () => {
    const attempted: string[] = [];
    const repoStore = {
      async createRun(runId: string): Promise<boolean> {
        attempted.push(runId);
        return runId === "run-2";
      },
    };
    let index = 0;
    const nextRunId = (): string => {
      index += 1;
      return `run-${index}`;
    };

    const runId = await reserveRunId(repoStore as never, nextRunId);

    expect(runId).toBe("run-2");
    expect(attempted).toEqual(["run-1", "run-2"]);
  });
});
