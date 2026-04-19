import { describe, expect, it } from "vitest";
import type { SDKAssistantMessage } from "../src/sdk/agent-client.js";
import {
  parseAssistantJsonFromMessages,
  parseAssistantJsonFromText,
  streamToCallbacks,
} from "../src/sdk/agent-client.js";

function makeAssistant(text: string): SDKAssistantMessage {
  return {
    type: "assistant",
    agent_id: "agent-x",
    run_id: "run-x",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

describe("parseAssistantJsonFromText", () => {
  it("parses fenced json blocks", () => {
    const text = 'Prelude\n```json\n{"status":"completed","task_id":"a","outputs":{}}\n```\nEpilogue';
    expect(parseAssistantJsonFromText(text)).toEqual({ status: "completed", task_id: "a", outputs: {} });
  });

  it("prefers the last fenced block", () => {
    const text = '```json\n{"first":1}\n```\n\n```json\n{"second":2}\n```';
    expect(parseAssistantJsonFromText(text)).toEqual({ second: 2 });
  });

  it("falls back to a bare balanced object at the tail", () => {
    const text = 'Here is the result: {"status":"completed","outputs":{"k":"v"}}';
    expect(parseAssistantJsonFromText(text)).toEqual({ status: "completed", outputs: { k: "v" } });
  });

  it("repairs trailing commas via jsonrepair fallback", () => {
    const text = 'Chatter\n```json\n{"a":1,"b":2,}\n```';
    expect(parseAssistantJsonFromText(text)).toEqual({ a: 1, b: 2 });
  });

  it("returns null for text with no json", () => {
    expect(parseAssistantJsonFromText("just some prose, no structure")).toBeNull();
  });

  it("collects across multiple assistant messages", () => {
    const messages = [makeAssistant("Start"), makeAssistant('```json\n{"ok":true}\n```')];
    expect(parseAssistantJsonFromMessages(messages)).toEqual({ ok: true });
  });
});

describe("streamToCallbacks", () => {
  it("dispatches events by type", async () => {
    const events: string[] = [];
    const run = {
      async *stream() {
        yield { type: "system", agent_id: "a", run_id: "r", subtype: "init" } as never;
        yield { type: "assistant", agent_id: "a", run_id: "r", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } } as never;
        yield { type: "status", agent_id: "a", run_id: "r", status: "RUNNING" } as never;
        yield { type: "tool_call", agent_id: "a", run_id: "r", call_id: "c", name: "shell", status: "completed" } as never;
      },
    } as unknown as Parameters<typeof streamToCallbacks>[0];
    await streamToCallbacks(run, {
      onSystem: () => { events.push("system"); },
      onAssistant: () => { events.push("assistant"); },
      onStatus: () => { events.push("status"); },
      onToolCall: () => { events.push("tool_call"); },
    });
    expect(events).toEqual(["system", "assistant", "status", "tool_call"]);
  });

  it("routes stream errors to onError", async () => {
    const run = {
      async *stream() {
        throw new Error("boom");
      },
    } as unknown as Parameters<typeof streamToCallbacks>[0];
    let caught: unknown = null;
    await streamToCallbacks(run, {
      onError: (err) => {
        caught = err;
      },
    });
    expect((caught as Error).message).toBe("boom");
  });
});
