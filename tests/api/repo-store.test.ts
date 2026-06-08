import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:timers/promises", () => ({
  setTimeout: vi.fn(async () => {}),
}));

import { RateLimitError, RepoStoreClient } from "../../src/api/repo-store.js";

type FetchMock = ReturnType<typeof vi.fn>;

function encodeContent(content: string): string {
  return Buffer.from(content, "utf8").toString("base64");
}

function contentsResponse(content: string, sha: string): Response {
  return new Response(JSON.stringify({ content: encodeContent(content), sha }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("RepoStoreClient", () => {
  let fetchMock: FetchMock;
  const originalFetch = globalThis.fetch;
  const owner = "acme";
  const repo = "bootstrap";
  const runId = "run-1";

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("readFile returns empty string when the run file is missing", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    const client = new RepoStoreClient("ghp-test", owner, repo);
    await expect(client.readFile(runId, "state.json")).resolves.toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries transient 503 responses then returns file content", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("svc", { status: 503 }))
      .mockResolvedValueOnce(contentsResponse('{"status":"running"}', "sha1"));
    const client = new RepoStoreClient("ghp-test", owner, repo);
    await expect(client.readFile(runId, "state.json")).resolves.toBe('{"status":"running"}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("429 retries honor Retry-After then succeed", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(contentsResponse("ok", "sha1"));
    const client = new RepoStoreClient("ghp-test", owner, repo);
    await expect(client.readFile(runId, "events.jsonl")).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("429 after max retries throws RateLimitError", async () => {
    for (let i = 0; i < 6; i++) {
      fetchMock.mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "0" } }));
    }
    const client = new RepoStoreClient("ghp-test", owner, repo);
    await expect(client.readFile(runId, "state.json")).rejects.toBeInstanceOf(RateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("writeFile retries optimistic concurrency conflicts on 409", async () => {
    fetchMock
      .mockResolvedValueOnce(contentsResponse("old", "sha-old"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Conflict" }), { status: 409 }))
      .mockResolvedValueOnce(contentsResponse("newer", "sha-new"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: encodeContent("written") }), { status: 200 }));
    const client = new RepoStoreClient("ghp-test", owner, repo);
    await expect(client.writeFile(runId, "state.json", "written")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const putCalls = fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "PUT");
    expect(putCalls).toHaveLength(2);
    const firstPutBody = JSON.parse(String((putCalls[0]![1] as RequestInit).body));
    const secondPutBody = JSON.parse(String((putCalls[1]![1] as RequestInit).body));
    expect(firstPutBody.sha).toBe("sha-old");
    expect(secondPutBody.sha).toBe("sha-new");
  });

  it("updateFile retries 422 write conflicts", async () => {
    fetchMock
      .mockResolvedValueOnce(contentsResponse("line\n", "sha1"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Unprocessable" }), { status: 422 }))
      .mockResolvedValueOnce(contentsResponse("line\n", "sha2"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: encodeContent("line\nmore\n") }), { status: 200 }));
    const client = new RepoStoreClient("ghp-test", owner, repo);
    const appendMore = (current: string) => current + "more\n";
    await expect(client.updateFile(runId, "events.jsonl", appendMore)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("surfaces non-retryable GitHub errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    const client = new RepoStoreClient("ghp-test", owner, repo);
    await expect(client.readFile(runId, "state.json")).rejects.toMatchObject({
      name: "RepoStoreError",
      statusCode: 403,
    });
  });

  it("listRunFiles returns content entry names for the run branch", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { name: "state.json" },
          { name: "events.jsonl" },
          { type: "dir", name: "transcripts" },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = new RepoStoreClient("ghp-test", owner, repo);
    await expect(client.listRunFiles(runId)).resolves.toEqual(["state.json", "events.jsonl", "transcripts"]);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain(`/contents/?ref=${encodeURIComponent(`run/${runId}`)}`);
  });

  it("listRunFiles returns an empty list when the run branch is missing", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    const client = new RepoStoreClient("ghp-test", owner, repo);
    await expect(client.listRunFiles(runId)).resolves.toEqual([]);
  });

  it("deleteFile is a no-op when the file is absent", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    const client = new RepoStoreClient("ghp-test", owner, repo);
    await expect(client.deleteFile(runId, "agent-t1.json")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deleteFile issues DELETE when the file exists", async () => {
    fetchMock
      .mockResolvedValueOnce(contentsResponse("{}", "sha-del"))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const client = new RepoStoreClient("ghp-test", owner, repo);
    await expect(client.deleteFile(runId, "agent-t1.json")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const deleteCall = fetchMock.mock.calls[1]!;
    expect((deleteCall[1] as RequestInit).method).toBe("DELETE");
    const body = JSON.parse(String((deleteCall[1] as RequestInit).body));
    expect(body.sha).toBe("sha-del");
    expect(body.branch).toBe(`run/${runId}`);
  });
});
