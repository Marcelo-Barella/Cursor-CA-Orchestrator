import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorApiClient, CursorApiError } from "../../src/api/cursor-api-client.js";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("CursorApiClient", () => {
  let fetchMock: FetchMock;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("listModels sends Basic auth with apiKey:", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: ["composer-2", "gpt-5.4"] }));
    const client = new CursorApiClient("sk-test");
    const models = await client.listModels();
    expect(models).toEqual(["composer-2", "gpt-5.4"]);
    const call = fetchMock.mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    expect(url).toBe("https://api.cursor.com/v0/models");
    const expected = `Basic ${Buffer.from("sk-test:").toString("base64")}`;
    expect((init.headers as Record<string, string>).Authorization).toBe(expected);
  });

  it("listRepositories returns owner/name/repository triples", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        repositories: [
          { owner: "acme", name: "api", repository: "https://github.com/acme/api" },
        ],
      }),
    );
    const client = new CursorApiClient("sk-test");
    const repos = await client.listRepositories();
    expect(repos).toEqual([{ owner: "acme", name: "api", repository: "https://github.com/acme/api" }]);
  });

  it("401 surfaces CursorApiError with statusCode 401", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    const client = new CursorApiClient("sk-bad");
    await expect(client.listModels()).rejects.toMatchObject({
      name: "CursorApiError",
      statusCode: 401,
    });
  });

  it("transient 503 is retried then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("svc", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ models: ["composer-2"] }));
    const client = new CursorApiClient("sk-test", { sleep: async () => {} });
    const models = await client.listModels();
    expect(models).toEqual(["composer-2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("429 on /v0/models retries up to 5 times honoring Retry-After", async () => {
    const sleepCalls: number[] = [];
    for (let i = 0; i < 5; i++) {
      fetchMock.mockResolvedValueOnce(
        new Response("", { status: 429, headers: { "Retry-After": "1" } }),
      );
    }
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: ["composer-2"] }));
    const client = new CursorApiClient("sk-test", { sleep: async (ms) => { sleepCalls.push(ms); } });
    const models = await client.listModels();
    expect(models).toEqual(["composer-2"]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(sleepCalls.every((ms) => ms >= 1000)).toBe(true);
  });

  it("429 on /v0/repositories retries only once then throws", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response("", { status: 429 }));
    const client = new CursorApiClient("sk-test", { sleep: async () => {} });
    await expect(client.listRepositories()).rejects.toMatchObject({
      name: "CursorApiError",
      statusCode: 429,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("network error retried then surfaces with statusCode 0", async () => {
    for (let i = 0; i < 4; i++) {
      fetchMock.mockRejectedValueOnce(new TypeError("network"));
    }
    const client = new CursorApiClient("sk-test", { sleep: async () => {} });
    const err = await client.listModels().catch((e) => e);
    expect(err).toBeInstanceOf(CursorApiError);
    expect(err.statusCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
