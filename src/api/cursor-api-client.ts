const BASE_URL = "https://api.cursor.com";

const INITIAL_DELAY_MS = 5000;
const MAX_DELAY_MS = 60000;
const BACKOFF_MULT = 2;
const JITTER_FACTOR = 0.2;
const MAX_RETRIES_MODELS_429 = 5;
const MAX_RETRIES_REPOS_429 = 1;
const MAX_RETRIES_TRANSIENT = 3;
const MAX_RETRIES_NETWORK = 3;
const TRANSIENT_CODES = new Set([502, 503, 504]);

export type RepoInfo = {
  owner: string;
  name: string;
  repository: string;
};

export class CursorApiError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 0) {
    super(message);
    this.name = "CursorApiError";
    this.statusCode = statusCode;
  }
}

type SleepFn = (ms: number) => Promise<void>;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function computeBackoffMs(attempt: number): number {
  const d = Math.min(INITIAL_DELAY_MS * BACKOFF_MULT ** attempt, MAX_DELAY_MS);
  const jitter = d * JITTER_FACTOR;
  return Math.ceil(d + (Math.random() * 2 - 1) * jitter);
}

function compute429Ms(attempt: number, retryAfter: string | null): number {
  let d = computeBackoffMs(attempt);
  if (retryAfter !== null) {
    const v = Number.parseFloat(retryAfter);
    if (Number.isFinite(v)) {
      d = Math.max(d, Math.ceil(v * 1000));
    }
  }
  return d;
}

export class CursorApiClient {
  private readonly apiKey: string;
  private readonly sleep: SleepFn;

  constructor(apiKey: string, opts: { sleep?: SleepFn } = {}) {
    this.apiKey = apiKey;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async listModels(): Promise<string[]> {
    const data = (await this.request<{ models?: unknown }>("/v0/models", MAX_RETRIES_MODELS_429)) ?? {};
    if (!Array.isArray(data.models)) {
      throw new CursorApiError("Malformed /v0/models response: missing models array");
    }
    return data.models.filter((x): x is string => typeof x === "string");
  }

  async listRepositories(): Promise<RepoInfo[]> {
    const data = (await this.request<{ repositories?: unknown }>("/v0/repositories", MAX_RETRIES_REPOS_429)) ?? {};
    if (!Array.isArray(data.repositories)) {
      throw new CursorApiError("Malformed /v0/repositories response: missing repositories array");
    }
    const out: RepoInfo[] = [];
    for (const r of data.repositories) {
      if (r && typeof r === "object" && "owner" in r && "name" in r && "repository" in r) {
        const rr = r as { owner: unknown; name: unknown; repository: unknown };
        if (typeof rr.owner === "string" && typeof rr.name === "string" && typeof rr.repository === "string") {
          out.push({ owner: rr.owner, name: rr.name, repository: rr.repository });
        }
      }
    }
    return out;
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.apiKey}:`, "utf8").toString("base64")}`;
  }

  private async request<T>(pathPart: string, maxRetries429: number): Promise<T> {
    const url = `${BASE_URL}${pathPart}`;
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: "application/json",
    };
    let retries429 = 0;
    let retriesTransient = 0;
    let retriesNetwork = 0;
    while (true) {
      let resp: Response;
      try {
        resp = await fetch(url, { method: "GET", headers });
      } catch (e) {
        if (retriesNetwork < MAX_RETRIES_NETWORK) {
          await this.sleep(computeBackoffMs(retriesNetwork));
          retriesNetwork++;
          continue;
        }
        throw new CursorApiError(`Cursor API network error after max retries: ${String(e)}`, 0);
      }
      if (resp.status === 429) {
        if (retries429 < maxRetries429) {
          await this.sleep(compute429Ms(retries429, resp.headers.get("Retry-After")));
          retries429++;
          continue;
        }
        throw new CursorApiError("Cursor API rate limit exceeded after max retries", 429);
      }
      if (TRANSIENT_CODES.has(resp.status)) {
        if (retriesTransient < MAX_RETRIES_TRANSIENT) {
          await this.sleep(computeBackoffMs(retriesTransient));
          retriesTransient++;
          continue;
        }
        throw new CursorApiError(`Cursor API transient error ${resp.status} after max retries`, resp.status);
      }
      if (resp.status >= 400) {
        const text = await resp.text().catch(() => "");
        throw new CursorApiError(`Cursor API error: ${resp.status} ${text.slice(0, 500)}`, resp.status);
      }
      return (await resp.json()) as T;
    }
  }
}
