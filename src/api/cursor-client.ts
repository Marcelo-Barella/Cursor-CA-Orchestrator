import { setTimeout as delay } from "node:timers/promises";

const BASE_URL = "https://api.cursor.com";

const INITIAL_DELAY = 5.0;
const BACKOFF_MULTIPLIER = 2.0;
const MAX_DELAY = 60.0;
const MAX_RETRIES_429 = 5;
const MAX_RETRIES_TRANSIENT = 3;
const JITTER_FACTOR = 0.2;
const TRANSIENT_CODES = new Set([502, 503, 504]);

export class AgentAPIError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 0) {
    super(message);
    this.name = "AgentAPIError";
    this.statusCode = statusCode;
  }
}

export class AgentNotFound extends AgentAPIError {
  constructor(agentId = "") {
    super(`Agent not found: ${agentId}`, 404);
    this.name = "AgentNotFound";
  }
}

export class RateLimitError extends AgentAPIError {
  retryAfter: number;
  constructor(message = "Rate limit exceeded", retryAfter = 0) {
    super(message, 429);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

export interface AgentInfo {
  id: string;
  name: string;
  status: string;
  repository: string;
  branch_name: string;
  pr_url: string | null;
  summary: string | null;
  created_at: string;
}

export interface Message {
  id: string;
  role: string;
  text: string;
}

function computeDelay(attempt: number): number {
  const d = Math.min(INITIAL_DELAY * BACKOFF_MULTIPLIER ** attempt, MAX_DELAY);
  const jitter = d * JITTER_FACTOR;
  return d + (Math.random() * 2 - 1) * jitter;
}

function compute429Delay(attempt: number, retryAfterHeader: string | null): number {
  let d = computeDelay(attempt);
  if (retryAfterHeader !== null) {
    const v = parseFloat(retryAfterHeader);
    if (!Number.isNaN(v)) {
      d = Math.max(d, v);
    }
  }
  return d;
}

function parseAgentInfo(data: Record<string, unknown>): AgentInfo {
  const target = (data.target as Record<string, unknown>) || {};
  const source = (data.source as Record<string, unknown>) || {};
  return {
    id: (data.id as string) ?? "",
    name: (data.name as string) ?? "",
    status: (data.status as string) ?? "UNKNOWN",
    repository: (source.repository as string) ?? "",
    branch_name: (target.branchName as string) ?? "",
    pr_url: (target.prUrl as string) ?? null,
    summary: (data.summary as string) ?? null,
    created_at: (data.createdAt as string) ?? "",
  };
}

export class CursorClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${BASE_URL}${path}`;
    let retries429 = 0;
    let retriesTransient = 0;
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`,
      "Content-Type": "application/json",
    };
    while (true) {
      const resp = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (resp.status === 429 && retries429 < MAX_RETRIES_429) {
        const d = compute429Delay(retries429, resp.headers.get("Retry-After"));
        retries429 += 1;
        await delay(Math.ceil(d * 1000));
        continue;
      }
      if (resp.status === 429) {
        throw new RateLimitError("Cursor API rate limit exceeded after max retries");
      }
      if (TRANSIENT_CODES.has(resp.status) && retriesTransient < MAX_RETRIES_TRANSIENT) {
        const d = computeDelay(retriesTransient);
        retriesTransient += 1;
        await delay(Math.ceil(d * 1000));
        continue;
      }
      if (TRANSIENT_CODES.has(resp.status)) {
        throw new AgentAPIError(`Transient error ${resp.status} after max retries`, resp.status);
      }
      if (resp.status === 404) {
        throw new AgentNotFound();
      }
      if (resp.status >= 400) {
        const text = await resp.text();
        throw new AgentAPIError(`Cursor API error: ${resp.status} ${text.slice(0, 500)}`, resp.status);
      }
      return resp;
    }
  }

  async launchAgent(
    prompt: string,
    repository: string,
    ref: string,
    model: string,
    branchName: string,
    autoPr: boolean,
  ): Promise<AgentInfo> {
    const body = {
      prompt: { text: prompt },
      model,
      source: { repository, ref },
      target: {
        autoCreatePr: autoPr,
        branchName,
        openAsCursorGithubApp: true,
        skipReviewerRequest: true,
      },
    };
    const resp = await this.request("POST", "/v0/agents", body);
    const data = (await resp.json()) as Record<string, unknown>;
    return parseAgentInfo(data);
  }

  async getAgent(agentId: string): Promise<AgentInfo> {
    const resp = await this.request("GET", `/v0/agents/${agentId}`);
    const data = (await resp.json()) as Record<string, unknown>;
    return parseAgentInfo(data);
  }

  async listAgents(limit = 100): Promise<AgentInfo[]> {
    const resp = await this.request("GET", `/v0/agents?limit=${limit}`);
    const data = (await resp.json()) as { agents?: Record<string, unknown>[] };
    return (data.agents ?? []).map((a) => parseAgentInfo(a));
  }

  async getConversation(agentId: string): Promise<Message[]> {
    const resp = await this.request("GET", `/v0/agents/${agentId}/conversation`);
    const data = (await resp.json()) as { messages?: Record<string, unknown>[] };
    return (data.messages ?? []).map((m) => ({
      id: (m.id as string) ?? "",
      role: m.type === "user_message" ? "user" : "assistant",
      text: (m.text as string) ?? "",
    }));
  }

  async sendFollowup(agentId: string, prompt: string): Promise<void> {
    await this.request("POST", `/v0/agents/${agentId}/followup`, { prompt: { text: prompt } });
  }

  async stopAgent(agentId: string): Promise<void> {
    await this.request("POST", `/v0/agents/${agentId}/stop`);
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.request("DELETE", `/v0/agents/${agentId}`);
  }

  async listModels(): Promise<unknown> {
    const resp = await this.request("GET", "/v0/models");
    return resp.json();
  }
}
