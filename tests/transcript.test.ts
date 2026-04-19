import { describe, expect, it } from "vitest";
import { createTranscriptWriter } from "../src/sdk/transcript.js";
import type { RepoStoreClient } from "../src/api/repo-store.js";
import type { SDKMessage } from "../src/sdk/agent-client.js";

function makeEvent(text: string): SDKMessage {
  return {
    type: "assistant",
    agent_id: "a",
    run_id: "r",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

describe("transcript writer", () => {
  it("flushes on batch size threshold", async () => {
    let stored = "";
    const repoStore = {
      async updateFile(
        _runId: string,
        filePath: string,
        updater: (current: string) => string | Promise<string>,
      ): Promise<void> {
        expect(filePath).toBe("transcripts/task-x.jsonl");
        stored = await updater(stored);
      },
    } as unknown as RepoStoreClient;
    const writer = createTranscriptWriter({ repoStore, runId: "r1", taskId: "task-x", batchSize: 3, batchMs: 10_000 });
    writer.enqueue(makeEvent("a"));
    writer.enqueue(makeEvent("b"));
    writer.enqueue(makeEvent("c"));
    await writer.flush();
    const lines = stored.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { event: { type: string } };
      expect(parsed.event.type).toBe("assistant");
    }
  });

  it("appends to existing content", async () => {
    let stored = '{"seq":0,"event":{"type":"system","agent_id":"a","run_id":"r"}}\n';
    const repoStore = {
      async updateFile(
        _runId: string,
        _filePath: string,
        updater: (current: string) => string | Promise<string>,
      ): Promise<void> {
        stored = await updater(stored);
      },
    } as unknown as RepoStoreClient;
    const writer = createTranscriptWriter({ repoStore, runId: "r1", taskId: "task-x", batchSize: 1 });
    writer.enqueue(makeEvent("hi"));
    await writer.flush();
    expect(stored.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("flush with empty buffer is a no-op", async () => {
    let updateCalls = 0;
    const repoStore = {
      async updateFile(): Promise<void> {
        updateCalls += 1;
      },
    } as unknown as RepoStoreClient;
    const writer = createTranscriptWriter({ repoStore, runId: "r1", taskId: "task-x" });
    await writer.flush();
    expect(updateCalls).toBe(0);
  });
});
