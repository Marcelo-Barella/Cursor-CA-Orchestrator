import { setTimeout as delay } from "node:timers/promises";

const BASE_URL = "https://api.github.com";

const INITIAL_DELAY = 5.0;
const BACKOFF_MULTIPLIER = 2.0;
const MAX_DELAY = 60.0;
const MAX_RETRIES_429 = 5;
const MAX_RETRIES_TRANSIENT = 3;
const MAX_RETRIES_409 = 3;
const MAX_RETRIES_NETWORK = 3;
const JITTER_FACTOR = 0.2;
const TRANSIENT_CODES = new Set([502, 503, 504]);

export class RepoStoreError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 0) {
    super(message);
    this.name = "RepoStoreError";
    this.statusCode = statusCode;
  }
}

export class RepoStoreNotFound extends RepoStoreError {
  constructor(path = "") {
    super(`Not found: ${path}`, 404);
    this.name = "RepoStoreNotFound";
  }
}

export class RateLimitError extends RepoStoreError {
  retryAfter: number;
  constructor(message = "Rate limit exceeded", retryAfter = 0) {
    super(message, 429);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

function encodeContent(content: string): string {
  return Buffer.from(content, "utf8").toString("base64");
}

function decodeContent(encoded: string): string {
  return Buffer.from(encoded.replace(/\n/g, ""), "base64").toString("utf8");
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

export class RepoStoreClient {
  private readonly token: string;
  private readonly owner: string;
  private readonly repo: string;
  private _rateLimitRemaining: number | null = null;
  private _rateLimitLimit: number | null = null;

  constructor(token: string, owner: string, repo: string) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
  }

  get rateLimitRemaining(): number | null {
    return this._rateLimitRemaining;
  }

  get rateLimitLimit(): number | null {
    return this._rateLimitLimit;
  }

  private trackRateLimit(resp: Response): void {
    const remaining = resp.headers.get("X-RateLimit-Remaining");
    if (remaining !== null) {
      this._rateLimitRemaining = parseInt(remaining, 10);
    }
    const limit = resp.headers.get("X-RateLimit-Limit");
    if (limit !== null) {
      this._rateLimitLimit = parseInt(limit, 10);
    }
  }

  private async request(method: string, url: string, body?: unknown): Promise<Response> {
    let retries429 = 0;
    let retriesTransient = 0;
    let retriesNetwork = 0;
    const headers: Record<string, string> = {
      Authorization: `token ${this.token}`,
      Accept: "application/vnd.github+json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    while (true) {
      try {
        const resp = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        this.trackRateLimit(resp);
        if (resp.status === 429 && retries429 < MAX_RETRIES_429) {
          const d = compute429Delay(retries429, resp.headers.get("Retry-After"));
          retries429 += 1;
          await delay(Math.ceil(d * 1000));
          continue;
        }
        if (resp.status === 429) {
          throw new RateLimitError("GitHub API rate limit exceeded after max retries");
        }
        if (TRANSIENT_CODES.has(resp.status) && retriesTransient < MAX_RETRIES_TRANSIENT) {
          const d = computeDelay(retriesTransient);
          retriesTransient += 1;
          await delay(Math.ceil(d * 1000));
          continue;
        }
        if (TRANSIENT_CODES.has(resp.status)) {
          throw new RepoStoreError(`Transient error ${resp.status} after max retries`, resp.status);
        }
        if (resp.status === 404) {
          throw new RepoStoreNotFound();
        }
        if (resp.status >= 400) {
          const text = await resp.text();
          throw new RepoStoreError(`GitHub API error: ${resp.status} ${text.slice(0, 500)}`, resp.status);
        }
        return resp;
      } catch (e) {
        if (e instanceof RepoStoreError) {
          throw e;
        }
        if (retriesNetwork < MAX_RETRIES_NETWORK) {
          const d = computeDelay(retriesNetwork);
          retriesNetwork += 1;
          await delay(Math.ceil(d * 1000));
          continue;
        }
        throw new RepoStoreError(`GitHub API network error after max retries: ${e}`);
      }
    }
  }

  private async getDefaultBranchSha(): Promise<string> {
    const url = `${BASE_URL}/repos/${this.owner}/${this.repo}`;
    const resp = await this.request("GET", url);
    const data = (await resp.json()) as { default_branch?: string };
    const defaultBranch = data.default_branch ?? "main";
    const refUrl = `${BASE_URL}/repos/${this.owner}/${this.repo}/git/ref/heads/${defaultBranch}`;
    const refResp = await this.request("GET", refUrl);
    const refData = (await refResp.json()) as { object?: { sha?: string } };
    return refData.object?.sha ?? "";
  }

  private async getFileSha(runId: string, filename: string): Promise<string | null> {
    const url = `${BASE_URL}/repos/${this.owner}/${this.repo}/contents/${filename}?ref=${encodeURIComponent(`run/${runId}`)}`;
    try {
      const resp = await this.request("GET", url);
      const data = (await resp.json()) as { sha?: string };
      return data.sha ?? null;
    } catch (e) {
      if (e instanceof RepoStoreNotFound) {
        return null;
      }
      throw e;
    }
  }

  async createRun(runId: string): Promise<void> {
    const sha = await this.getDefaultBranchSha();
    const url = `${BASE_URL}/repos/${this.owner}/${this.repo}/git/refs`;
    const payload = { ref: `refs/heads/run/${runId}`, sha };
    try {
      await this.request("POST", url, payload);
    } catch (e) {
      if (e instanceof RepoStoreError && e.statusCode === 422) {
        return;
      }
      throw e;
    }
  }

  async readFile(runId: string, filename: string): Promise<string> {
    const url = `${BASE_URL}/repos/${this.owner}/${this.repo}/contents/${filename}?ref=${encodeURIComponent(`run/${runId}`)}`;
    try {
      const resp = await this.request("GET", url);
      const data = (await resp.json()) as { content?: string };
      const encoded = data.content ?? "";
      return decodeContent(encoded);
    } catch (e) {
      if (e instanceof RepoStoreNotFound) {
        return "";
      }
      throw e;
    }
  }

  async writeFile(runId: string, filename: string, content: string): Promise<void> {
    const url = `${BASE_URL}/repos/${this.owner}/${this.repo}/contents/${filename}`;
    const branch = `run/${runId}`;
    const encoded = encodeContent(content);
    for (let attempt = 0; attempt <= MAX_RETRIES_409; attempt++) {
      const sha = await this.getFileSha(runId, filename);
      const payload: Record<string, unknown> = {
        message: `update ${filename}`,
        content: encoded,
        branch,
      };
      if (sha !== null) {
        payload.sha = sha;
      }
      try {
        await this.request("PUT", url, payload);
        return;
      } catch (e) {
        if (e instanceof RepoStoreError && (e.statusCode === 409 || e.statusCode === 422) && attempt < MAX_RETRIES_409) {
          await delay(Math.ceil(computeDelay(attempt) * 1000));
          continue;
        }
        throw e;
      }
    }
  }

  async deleteFile(runId: string, filename: string): Promise<void> {
    const sha = await this.getFileSha(runId, filename);
    if (sha === null) {
      return;
    }
    const url = `${BASE_URL}/repos/${this.owner}/${this.repo}/contents/${filename}`;
    const payload = {
      message: `delete ${filename}`,
      sha,
      branch: `run/${runId}`,
    };
    try {
      await this.request("DELETE", url, payload);
    } catch (e) {
      if (e instanceof RepoStoreNotFound) {
        return;
      }
      throw e;
    }
  }

  async listRunFiles(runId: string): Promise<string[]> {
    const url = `${BASE_URL}/repos/${this.owner}/${this.repo}/contents/?ref=${encodeURIComponent(`run/${runId}`)}`;
    try {
      const resp = await this.request("GET", url);
      const items = (await resp.json()) as { name?: string }[];
      if (!Array.isArray(items)) return [];
      return items.filter((x) => typeof x === "object" && x && "name" in x).map((x) => x.name as string);
    } catch (e) {
      if (e instanceof RepoStoreNotFound) {
        return [];
      }
      throw e;
    }
  }

  private async getBranchSha(runId: string): Promise<string> {
    const url = `${BASE_URL}/repos/${this.owner}/${this.repo}/git/ref/heads/run/${runId}`;
    const resp = await this.request("GET", url);
    const data = (await resp.json()) as { object?: { sha?: string } };
    return data.object?.sha ?? "";
  }

  private async createBlob(content: string): Promise<string> {
    const url = `${BASE_URL}/repos/${this.owner}/${this.repo}/git/blobs`;
    const resp = await this.request("POST", url, { content, encoding: "utf-8" });
    const data = (await resp.json()) as { sha?: string };
    return data.sha ?? "";
  }

  private async createTree(fileBlobs: Record<string, string>): Promise<string> {
    const tree = Object.entries(fileBlobs).map(([path, blobSha]) => ({
      path,
      mode: "100644",
      type: "blob",
      sha: blobSha,
    }));
    const url = `${BASE_URL}/repos/${this.owner}/${this.repo}/git/trees`;
    const resp = await this.request("POST", url, { tree });
    const data = (await resp.json()) as { sha?: string };
    return data.sha ?? "";
  }

  private async createCommit(message: string, treeSha: string, parentSha: string): Promise<string> {
    const url = `${BASE_URL}/repos/${this.owner}/${this.repo}/git/commits`;
    const resp = await this.request("POST", url, { message, tree: treeSha, parents: [parentSha] });
    const data = (await resp.json()) as { sha?: string };
    return data.sha ?? "";
  }

  private async updateBranchRef(runId: string, commitSha: string): Promise<void> {
    const url = `${BASE_URL}/repos/${this.owner}/${this.repo}/git/refs/heads/run/${runId}`;
    await this.request("PATCH", url, { sha: commitSha });
  }

  async listRunBranches(): Promise<string[]> {
    const url = `${BASE_URL}/repos/${this.owner}/${this.repo}/git/refs/heads/run/`;
    try {
      const resp = await this.request("GET", url);
      const items = (await resp.json()) as { ref?: string }[];
      if (!Array.isArray(items)) return [];
      return items
        .filter((x) => typeof x === "object" && x && "ref" in x)
        .map((x) => (x.ref as string).replace(/^refs\/heads\//, ""));
    } catch (e) {
      if (e instanceof RepoStoreNotFound) {
        return [];
      }
      throw e;
    }
  }

  async deleteRunBranch(runId: string): Promise<void> {
    const url = `${BASE_URL}/repos/${this.owner}/${this.repo}/git/refs/heads/run/${runId}`;
    try {
      await this.request("DELETE", url);
    } catch (e) {
      if (e instanceof RepoStoreNotFound) {
        return;
      }
      throw e;
    }
  }

  async batchWriteFiles(runId: string, files: Record<string, string>, message = "batch update"): Promise<void> {
    for (let attempt = 0; attempt <= MAX_RETRIES_409; attempt++) {
      const parentSha = await this.getBranchSha(runId);
      const fileBlobs: Record<string, string> = {};
      for (const [p, content] of Object.entries(files)) {
        fileBlobs[p] = await this.createBlob(content);
      }
      const treeSha = await this.createTree(fileBlobs);
      const commitSha = await this.createCommit(message, treeSha, parentSha);
      try {
        await this.updateBranchRef(runId, commitSha);
        return;
      } catch (e) {
        if (e instanceof RepoStoreError && e.statusCode === 422 && attempt < MAX_RETRIES_409) {
          await delay(Math.ceil(computeDelay(attempt) * 1000));
          continue;
        }
        throw e;
      }
    }
  }
}
