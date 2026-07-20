import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fanInTaskBranches } from "../../src/engine/fan-in.js";

describe("fanInTaskBranches", () => {
  let unmockedFetch: typeof fetch;

  beforeEach(() => {
    unmockedFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = unmockedFetch;
  });

  it("merges task branches into run branch in dependency order", async () => {
    const merges: string[] = [];
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      if (url.includes("/git/ref/heads/")) {
        const tail = decodeURIComponent(url.split("/git/ref/heads/")[1] ?? "");
        if (tail === "main") {
          return new Response(JSON.stringify({ object: { sha: "abc123" } }), { status: 200 });
        }
        if (tail === "cursor-orch/run1/main/run") {
          return new Response(JSON.stringify({ object: { sha: "runsha" } }), { status: 200 });
        }
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      if (url.includes("/merges") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { head?: string };
        merges.push(body.head ?? "");
        return new Response(JSON.stringify({ sha: "merged" }), { status: 201 });
      }
      return unmockedFetch(input, init);
    }) as typeof fetch;

    const result = await fanInTaskBranches("tok", {
      owner: "acme",
      repo: "svc",
      baseRef: "main",
      runBranch: "cursor-orch/run1/main/run",
      taskBranchesById: {
        "t-a": "cursor-orch/run1/t-a",
        "t-b": "cursor-orch/run1/t-b",
      },
      taskIds: ["t-a", "t-b"],
      graph: { "t-a": new Set(), "t-b": new Set(["t-a"]) },
    });
    expect(result).toEqual({ ok: true });
    expect(merges).toEqual(["cursor-orch/run1/t-a", "cursor-orch/run1/t-b"]);
  });

  it("marks merge conflicts", async () => {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      if (url.includes("/git/ref/heads/")) {
        return new Response(JSON.stringify({ object: { sha: "abc" } }), { status: 200 });
      }
      if (url.includes("/merges") && method === "POST") {
        return new Response(JSON.stringify({ message: "Merge conflict" }), { status: 409 });
      }
      return unmockedFetch(input, init);
    }) as typeof fetch;

    const result = await fanInTaskBranches("tok", {
      owner: "acme",
      repo: "svc",
      baseRef: "main",
      runBranch: "cursor-orch/run1/main/run",
      taskBranchesById: { "t-a": "cursor-orch/run1/t-a" },
      taskIds: ["t-a"],
      graph: { "t-a": new Set() },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toBe(true);
  });
});
