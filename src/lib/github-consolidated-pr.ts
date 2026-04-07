import { normalizeRepoToken } from "./repo-target.js";

function sanitizeRefSegment(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9._-]/g, "-");
}

const GITHUB_API = "https://api.github.com";

export function topoSortTaskGroup(taskIds: string[], graph: Record<string, Set<string>>): string[] {
  const idSet = new Set(taskIds);
  const result: string[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  function visit(id: string): void {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`Dependency cycle involving task ${id}`);
    }
    visiting.add(id);
    for (const d of graph[id] ?? []) {
      if (idSet.has(d)) visit(d);
    }
    visiting.delete(id);
    done.add(id);
    result.push(id);
  }
  for (const id of taskIds) {
    visit(id);
  }
  return result;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function ghJson(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const url = `${GITHUB_API}${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      ...ghHeaders(token),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: resp.ok, status: resp.status, json, text };
}

export function integrationBranchName(branchPrefix: string, runId: string, baseRef: string): string {
  const base = `${branchPrefix}/${runId}/${sanitizeRefSegment(baseRef)}/consolidated`;
  return base.replace(/[^a-zA-Z0-9/._-]/g, "-").replace(/\/+/g, "/");
}

export interface ConsolidateGroupInput {
  groupKey: string;
  owner: string;
  repo: string;
  baseRef: string;
  taskBranches: string[];
  title: string;
  body: string;
}

export interface ConsolidateResult {
  groupKey: string;
  prUrl: string | null;
  error: string | null;
}

export async function consolidateOneRepo(
  token: string,
  input: ConsolidateGroupInput,
  integrationBranch: string,
): Promise<ConsolidateResult> {
  const { owner, repo, baseRef, taskBranches, groupKey, title, body } = input;
  const repoPath = `/repos/${owner}/${repo}`;

  const refPath = `${repoPath}/git/ref/heads/${encodeURIComponent(baseRef)}`;
  let refResp = await ghJson(token, "GET", refPath);
  if (!refResp.ok) {
    return { groupKey, prUrl: null, error: `resolve base ref ${baseRef}: HTTP ${refResp.status} ${refResp.text.slice(0, 300)}` };
  }
  const refObj = refResp.json as { object?: { sha?: string } };
  const baseSha = refObj.object?.sha;
  if (!baseSha) {
    return { groupKey, prUrl: null, error: `missing SHA for ${baseRef}` };
  }

  const createRefBody = { ref: `refs/heads/${integrationBranch}`, sha: baseSha };
  let createRef = await ghJson(token, "POST", `${repoPath}/git/refs`, createRefBody);
  if (createRef.status === 422) {
    const del = await ghJson(token, "DELETE", `${repoPath}/git/refs/${encodeURIComponent(`refs/heads/${integrationBranch}`)}`);
    if (!del.ok && del.status !== 404) {
      return { groupKey, prUrl: null, error: `delete existing ${integrationBranch}: HTTP ${del.status}` };
    }
    createRef = await ghJson(token, "POST", `${repoPath}/git/refs`, createRefBody);
  }
  if (!createRef.ok) {
    return { groupKey, prUrl: null, error: `create integration branch: HTTP ${createRef.status} ${createRef.text.slice(0, 400)}` };
  }

  for (const head of taskBranches) {
    const merge = await ghJson(token, "POST", `${repoPath}/merges`, {
      base: integrationBranch,
      head,
      commit_message: `Merge ${head} into ${integrationBranch}`,
    });
    if (!merge.ok) {
      return {
        groupKey,
        prUrl: null,
        error: `merge ${head} into ${integrationBranch}: HTTP ${merge.status} ${merge.text.slice(0, 500)}`,
      };
    }
  }

  const pulls = await ghJson(token, "POST", `${repoPath}/pulls`, {
    title,
    body,
    head: integrationBranch,
    base: baseRef,
  });
  if (!pulls.ok) {
    return { groupKey, prUrl: null, error: `open PR: HTTP ${pulls.status} ${pulls.text.slice(0, 400)}` };
  }
  const pr = pulls.json as { html_url?: string };
  return { groupKey, prUrl: pr.html_url ?? null, error: pr.html_url ? null : "PR response missing html_url" };
}

export function groupKeyForRepo(repoUrl: string, ref: string): string {
  return `${normalizeRepoToken(repoUrl)}\0${ref}`;
}

