import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("v1 agent create fetch rewrite", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetModules();
  });

  it("strips branchName and autoGenerateBranch from POST /v1/agents", async () => {
    let capturedBody: string | undefined;
    const downstream = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? init.body : undefined;
      return new Response("{}", { status: 200 });
    });
    globalThis.fetch = downstream as typeof fetch;
    const { createDefaultAgentClient } = await import("../src/sdk/agent-client.js");
    createDefaultAgentClient("test-key");
    await fetch("https://api.cursor.com/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        branchName: "feature/x",
        autoGenerateBranch: true,
        prompt: { text: "hi" },
      }),
    });
    expect(downstream).toHaveBeenCalledOnce();
    const sent = JSON.parse(capturedBody!) as Record<string, unknown>;
    expect(sent).not.toHaveProperty("branchName");
    expect(sent).not.toHaveProperty("autoGenerateBranch");
    expect(sent.prompt).toEqual({ text: "hi" });
  });

  it("does not rewrite POST bodies for non-agent endpoints", async () => {
    let capturedBody: string | undefined;
    const downstream = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = typeof init?.body === "string" ? init.body : undefined;
      return new Response("{}", { status: 200 });
    });
    globalThis.fetch = downstream as typeof fetch;
    const { createDefaultAgentClient } = await import("../src/sdk/agent-client.js");
    createDefaultAgentClient("test-key");
    await fetch("https://api.cursor.com/v1/other", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branchName: "keep-me" }),
    });
    expect(JSON.parse(capturedBody!).branchName).toBe("keep-me");
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
