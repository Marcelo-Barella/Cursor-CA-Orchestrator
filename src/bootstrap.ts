import { setTimeout as delay } from "node:timers/promises";
import { REQUIRED_SDK_SPEC, buildRuntimeRef, packageRuntimeSnapshot, validatePayloadSize } from "./packager.js";

export const GITHUB_API = "https://api.github.com";

const INITIAL_DELAY = 5.0;
const BACKOFF_MULTIPLIER = 2.0;
const MAX_DELAY = 60.0;
const MAX_RETRIES_429 = 5;
const MAX_RETRIES_TRANSIENT = 3;
const JITTER_FACTOR = 0.2;
const TRANSIENT_CODES = new Set([502, 503, 504]);

export const BOOTSTRAP_INSTALL_COMMAND = `npm install --no-save --no-audit --no-fund --prefix . ${REQUIRED_SDK_SPEC}`;
export const BOOTSTRAP_ENTRYPOINT = "node dist/orchestrator-runtime.cjs";
export const RULE_PATH = ".cursor/rules/orchestrator.mdc";
export const READONLY_RULE_PATH = ".cursor/rules/readonly-guard.mdc";

export const RULE_TEMPLATE = `---
description: Orchestration bootstrap rule
globs:
alwaysApply: true
---

This is a pinned cursor-orch bootstrap runtime repository.
The launch prompt defines your task for this run. Follow the launch prompt exactly.
If the launch prompt instructs you to execute shell commands, run those commands exactly as written and report the requested raw output.

STRICT RULES:
- This repository is READ-ONLY. You have NO permission to write files under any circumstances.
- Do NOT modify any files in this repository.
- Do NOT create any new files other than what the executed commands create.
- Do NOT read or interpret the orchestration runtime source code.
- Do NOT retry failed commands unless the output explicitly requests it.
- Run the install command exactly as written; do not skip it.
- Report complete stdout and stderr output.
- ALL agents must push changes directly to the assigned branch.
`;

export const READONLY_GUARD_RULE = `---
description: Read-only bootstrap repository guard
globs:
alwaysApply: true
---

This is a bootstrap repository for cursor-orch. It must remain unchanged.
Do NOT create, modify, or delete any files in this repository.
Do NOT write code, fix errors, or add functionality.
Your only job is to execute commands as instructed by the orchestrator rule.
`;

function computeDelay(attempt: number): number {
  const d = Math.min(INITIAL_DELAY * BACKOFF_MULTIPLIER ** attempt, MAX_DELAY);
  const jitter = d * JITTER_FACTOR;
  return d + (Math.random() * 2 - 1) * jitter;
}

function compute429Delay(attempt: number, retryAfter: string | null): number {
  let d = computeDelay(attempt);
  if (retryAfter !== null) {
    const v = parseFloat(retryAfter);
    if (!Number.isNaN(v)) {
      d = Math.max(d, v);
    }
  }
  return d;
}

async function githubApi(session: { headers: Record<string, string> }, method: string, url: string, body?: unknown): Promise<Response> {
  let retries429 = 0;
  let retriesTransient = 0;
  while (true) {
    const resp = await fetch(url, {
      method,
      headers: session.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await resp.clone().text();
    const isSecondaryRateLimit = resp.status === 403 && (text.toLowerCase().includes("rate limit") || resp.headers.get("Retry-After"));
    if ((resp.status === 429 || isSecondaryRateLimit) && retries429 < MAX_RETRIES_429) {
      const wait = compute429Delay(retries429, resp.headers.get("Retry-After"));
      retries429 += 1;
      await delay(Math.ceil(wait * 1000));
      continue;
    }
    if (resp.status === 429 || isSecondaryRateLimit) {
      throw new Error(`GitHub rate limit exceeded for ${url}`);
    }
    if (TRANSIENT_CODES.has(resp.status) && retriesTransient < MAX_RETRIES_TRANSIENT) {
      const wait = computeDelay(retriesTransient);
      retriesTransient += 1;
      await delay(Math.ceil(wait * 1000));
      continue;
    }
    if (TRANSIENT_CODES.has(resp.status)) {
      throw new Error(`Transient error ${resp.status} for ${url}`);
    }
    return resp;
  }
}

export function buildBootstrapRule(): string {
  return RULE_TEMPLATE;
}

export function buildBootstrapSnapshotFiles(runtimeFiles?: Record<string, string> | null): Record<string, string> {
  const snapshot = runtimeFiles != null ? { ...runtimeFiles } : { ...packageRuntimeSnapshot() };
  snapshot[RULE_PATH] = buildBootstrapRule();
  snapshot[READONLY_RULE_PATH] = READONLY_GUARD_RULE;
  return snapshot;
}

export async function resolveGithubUser(headers: Record<string, string>): Promise<string> {
  const resp = await githubApi({ headers }, "GET", `${GITHUB_API}/user`);
  if (resp.status === 401) {
    throw new Error("GitHub token is invalid or expired (HTTP 401). Check your GH_TOKEN.");
  }
  if (resp.status === 403) {
    throw new Error("GitHub API forbidden (HTTP 403). Your token may lack required scopes or you are rate-limited.");
  }
  if (resp.status !== 200) {
    throw new Error(`Failed to resolve GitHub user: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { login: string };
  return data.login;
}

async function createRepo(headers: Record<string, string>, name: string): Promise<Record<string, unknown>> {
  const payload = {
    name,
    description: "Bootstrap repo for cursor-orch orchestration",
    private: true,
    auto_init: true,
    has_issues: false,
    has_projects: false,
    has_wiki: false,
  };
  const resp = await githubApi({ headers }, "POST", `${GITHUB_API}/user/repos`, payload);
  if (resp.status !== 200 && resp.status !== 201) {
    const t = await resp.text();
    throw new Error(`Failed to create repo: HTTP ${resp.status} ${t.slice(0, 300)}`);
  }
  const data = (await resp.json()) as Record<string, unknown>;
  await delay(2000);
  return data;
}

async function getRepo(headers: Record<string, string>, owner: string, repo: string): Promise<Record<string, unknown> | null> {
  const resp = await githubApi({ headers }, "GET", `${GITHUB_API}/repos/${owner}/${repo}`);
  if (resp.status === 404) {
    return null;
  }
  if (resp.status !== 200) {
    throw new Error(`Failed to check repo: HTTP ${resp.status}`);
  }
  return (await resp.json()) as Record<string, unknown>;
}

async function getRefSha(headers: Record<string, string>, owner: string, repo: string, ref: string): Promise<string | null> {
  const resp = await githubApi({ headers }, "GET", `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${ref}`);
  if (resp.status === 404) {
    return null;
  }
  if (resp.status !== 200) {
    throw new Error(`Failed to resolve ref ${ref}: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { object?: { sha?: string } };
  return data.object?.sha ?? null;
}

async function createBlob(headers: Record<string, string>, owner: string, repo: string, content: string): Promise<string> {
  const resp = await githubApi({ headers }, "POST", `${GITHUB_API}/repos/${owner}/${repo}/git/blobs`, {
    content,
    encoding: "utf-8",
  });
  if (resp.status !== 201) {
    const t = await resp.text();
    throw new Error(`Failed to create blob: HTTP ${resp.status} ${t.slice(0, 300)}`);
  }
  const data = (await resp.json()) as { sha: string };
  return data.sha;
}

async function createTree(
  headers: Record<string, string>,
  owner: string,
  repo: string,
  files: Record<string, string>,
): Promise<string> {
  const tree = await Promise.all(
    Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([path, content]) => ({
        path,
        mode: "100644",
        type: "blob",
        sha: await createBlob(headers, owner, repo, content),
      })),
  );
  const resp = await githubApi({ headers }, "POST", `${GITHUB_API}/repos/${owner}/${repo}/git/trees`, { tree });
  if (resp.status !== 201) {
    const t = await resp.text();
    throw new Error(`Failed to create tree: HTTP ${resp.status} ${t.slice(0, 300)}`);
  }
  const data = (await resp.json()) as { sha: string };
  return data.sha;
}

async function createCommit(
  headers: Record<string, string>,
  owner: string,
  repo: string,
  message: string,
  treeSha: string,
  parentSha: string,
): Promise<string> {
  const resp = await githubApi({ headers }, "POST", `${GITHUB_API}/repos/${owner}/${repo}/git/commits`, {
    message,
    tree: treeSha,
    parents: [parentSha],
  });
  if (resp.status !== 201) {
    const t = await resp.text();
    throw new Error(`Failed to create commit: HTTP ${resp.status} ${t.slice(0, 300)}`);
  }
  const data = (await resp.json()) as { sha: string };
  return data.sha;
}

async function createRef(headers: Record<string, string>, owner: string, repo: string, ref: string, sha: string): Promise<void> {
  const resp = await githubApi({ headers }, "POST", `${GITHUB_API}/repos/${owner}/${repo}/git/refs`, {
    ref: `refs/heads/${ref}`,
    sha,
  });
  if (resp.status === 422) {
    return;
  }
  if (resp.status !== 200 && resp.status !== 201) {
    const t = await resp.text();
    throw new Error(`Failed to create ref ${ref}: HTTP ${resp.status} ${t.slice(0, 300)}`);
  }
}

async function ensureRuntimeSnapshotRef(
  headers: Record<string, string>,
  owner: string,
  repo: string,
  defaultBranch: string,
  runtimeFiles: Record<string, string>,
): Promise<string> {
  const runtimeRef = buildRuntimeRef(runtimeFiles);
  if ((await getRefSha(headers, owner, repo, runtimeRef)) !== null) {
    return runtimeRef;
  }
  const parentSha = await getRefSha(headers, owner, repo, defaultBranch);
  if (!parentSha) {
    throw new Error(`Failed to resolve default branch head for ${defaultBranch}`);
  }
  const treeSha = await createTree(headers, owner, repo, runtimeFiles);
  const commitSha = await createCommit(headers, owner, repo, `Pin orchestration runtime ${runtimeRef}`, treeSha, parentSha);
  await createRef(headers, owner, repo, runtimeRef, commitSha);
  return runtimeRef;
}

export async function ensureBootstrapRepo(ghToken: string, repoName: string): Promise<{
  owner: string;
  name: string;
  url: string;
  default_branch: string;
  runtime_ref: string;
}> {
  const headers: Record<string, string> = {
    Authorization: `token ${ghToken}`,
    Accept: "application/vnd.github+json",
  };
  const owner = await resolveGithubUser(headers);
  let repoData = await getRepo(headers, owner, repoName);
  if (!repoData) {
    repoData = await createRepo(headers, repoName);
  }
  const runtimeFiles = buildBootstrapSnapshotFiles();
  validatePayloadSize(runtimeFiles);
  const defaultBranch = (repoData.default_branch as string) ?? "main";
  const runtimeRef = await ensureRuntimeSnapshotRef(headers, owner, repoName, defaultBranch, runtimeFiles);
  return {
    owner,
    name: repoName,
    url: repoData.html_url as string,
    default_branch: defaultBranch,
    runtime_ref: runtimeRef,
  };
}
