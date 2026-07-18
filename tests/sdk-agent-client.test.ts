import { UnsupportedRunOperationError, type RunOperation } from "@cursor/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SDKAssistantMessage, SdkAgent, SdkRun } from "../src/sdk/agent-client.js";
import {
  buildCloudAgentOptions,
  captureAssistantJson,
  fetchAgentConversationTextFromApi,
  parseAssistantJsonFromMessages,
  parseAssistantJsonFromText,
  streamToCallbacks,
  tryDownloadJsonArtifact,
} from "../src/sdk/agent-client.js";

function makeAssistant(text: string): SDKAssistantMessage {
  return {
    type: "assistant",
    agent_id: "agent-x",
    run_id: "run-x",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

const baseCloudOpts = {
  apiKey: "test-key",
  model: { id: "composer-2" as const },
  repoUrl: "https://github.com/acme/svc",
  startingRef: "main",
  autoCreatePR: false,
};

describe("buildCloudAgentOptions", () => {
  it("maps cloud repo fields and defaults skipReviewerRequest to true", () => {
    const opts = buildCloudAgentOptions({ ...baseCloudOpts, autoCreatePR: true });
    expect(opts.apiKey).toBe("test-key");
    expect(opts.cloud?.repos).toEqual([{ url: baseCloudOpts.repoUrl, startingRef: "main" }]);
    expect(opts.cloud?.autoCreatePR).toBe(true);
    expect(opts.cloud?.skipReviewerRequest).toBe(true);
  });

  it("includes mcpServers only when the map is non-empty", () => {
    const withMcp = buildCloudAgentOptions({
      ...baseCloudOpts,
      mcpServers: { local: { type: "http", url: "https://mcp.example" } },
    });
    expect(withMcp.mcpServers).toEqual({ local: { type: "http", url: "https://mcp.example" } });
    const without = buildCloudAgentOptions({ ...baseCloudOpts, mcpServers: {} });
    expect(without.mcpServers).toBeUndefined();
  });
});

describe("fetchAgentConversationTextFromApi", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null when fetch throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as typeof fetch;
    await expect(fetchAgentConversationTextFromApi("agent-1", "key")).resolves.toBeNull();
  });

  it("returns null for non-OK HTTP responses", async () => {
    globalThis.fetch = vi.fn(async () => new Response("err", { status: 503 })) as typeof fetch;
    await expect(fetchAgentConversationTextFromApi("agent-1", "key")).resolves.toBeNull();
  });

  it("returns null when the payload has no assistant_message entries", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ messages: [{ type: "user_message", text: "hi" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as typeof fetch;
    await expect(fetchAgentConversationTextFromApi("agent-1", "key")).resolves.toBeNull();
  });

  it("returns null when the response body is not valid JSON", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("not-json {{{", { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as typeof fetch;
    await expect(fetchAgentConversationTextFromApi("agent-1", "key")).resolves.toBeNull();
  });

  it("joins assistant_message text and URL-encodes the agent id", async () => {
    let requestedUrl = "";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(
        JSON.stringify({
          messages: [
            { type: "assistant_message", text: "line one\n" },
            { type: "assistant_message", text: "line two" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const text = await fetchAgentConversationTextFromApi("agent/with space", "secret");
    expect(requestedUrl).toBe("https://api.cursor.com/v0/agents/agent%2Fwith%20space/conversation");
    expect(text).toBe("line one\nline two");
  });
});

describe("captureAssistantJson", () => {
  it("falls back to run.result when the stream has no assistant messages", async () => {
    const run = {
      async *stream() {},
      result: '{"status":"completed","task_id":"t1","outputs":{}}',
    } as unknown as SdkRun;
    await expect(captureAssistantJson(run)).resolves.toEqual({
      status: "completed",
      task_id: "t1",
      outputs: {},
    });
  });

  it("returns null when stream and run.result are both empty", async () => {
    const run = {
      async *stream() {},
      result: "",
    } as unknown as SdkRun;
    await expect(captureAssistantJson(run)).resolves.toBeNull();
  });
});

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

describe("tryDownloadJsonArtifact", () => {
  function mockAgent(overrides: Partial<SdkAgent>): SdkAgent {
    return {
      listArtifacts: async () => [],
      downloadArtifact: async () => Buffer.from("{}"),
      ...overrides,
    } as SdkAgent;
  }

  it("returns parsed JSON when the artifact exists", async () => {
    const agent = mockAgent({
      listArtifacts: async () => [{ path: "cursor-orch-output.json", sizeBytes: 2, updatedAt: "" }],
      downloadArtifact: async () => Buffer.from('{"status":"completed"}', "utf8"),
    });
    const result = await tryDownloadJsonArtifact(agent, "cursor-orch-output.json");
    expect(result).toEqual({ value: { status: "completed" }, error: null });
  });

  it("returns not found when the artifact path is absent", async () => {
    const agent = mockAgent({
      listArtifacts: async () => [{ path: "other.json", sizeBytes: 1, updatedAt: "" }],
    });
    const result = await tryDownloadJsonArtifact(agent, "cursor-orch-output.json");
    expect(result).toEqual({ value: null, error: "not found" });
  });

  it("returns an error when artifact bytes are empty or not JSON", async () => {
    const agent = mockAgent({
      listArtifacts: async () => [{ path: "cursor-orch-output.json", sizeBytes: 0, updatedAt: "" }],
      downloadArtifact: async () => Buffer.from("   ", "utf8"),
    });
    const result = await tryDownloadJsonArtifact(agent, "cursor-orch-output.json");
    expect(result).toEqual({ value: null, error: "artifact was not valid JSON" });
  });

  it("surfaces download errors from the agent", async () => {
    const agent = mockAgent({
      listArtifacts: async () => [{ path: "cursor-orch-output.json", sizeBytes: 1, updatedAt: "" }],
      downloadArtifact: async () => {
        throw new Error("network down");
      },
    });
    const result = await tryDownloadJsonArtifact(agent, "cursor-orch-output.json");
    expect(result).toEqual({ value: null, error: "network down" });
  });

  it("returns artifacts unsupported when listArtifacts is unsupported", async () => {
    const agent = mockAgent({
      listArtifacts: async () => {
        throw new UnsupportedRunOperationError("listArtifacts" as RunOperation);
      },
    });
    const result = await tryDownloadJsonArtifact(agent, "cursor-orch-output.json");
    expect(result).toEqual({ value: null, error: "artifacts unsupported" });
  });

  it("returns download unsupported when downloadArtifact is unsupported", async () => {
    const agent = mockAgent({
      listArtifacts: async () => [{ path: "cursor-orch-output.json", sizeBytes: 1, updatedAt: "" }],
      downloadArtifact: async () => {
        throw new UnsupportedRunOperationError("downloadArtifact" as RunOperation);
      },
    });
    const result = await tryDownloadJsonArtifact(agent, "cursor-orch-output.json");
    expect(result).toEqual({ value: null, error: "download unsupported" });
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
