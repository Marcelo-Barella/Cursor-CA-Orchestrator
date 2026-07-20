import {
  ensureRunBranchFromBase,
  mergeBranches,
  topoSortTaskGroup,
} from "../lib/github-consolidated-pr.js";

export type FanInRepoInput = {
  owner: string;
  repo: string;
  baseRef: string;
  runBranch: string;
  taskBranchesById: Record<string, string>;
  taskIds: string[];
  graph: Record<string, Set<string>>;
};

export type FanInResult =
  | { ok: true }
  | { ok: false; conflict: true; error: string }
  | { ok: false; conflict: false; error: string };

function isConflict(status: number, text: string): boolean {
  if (status === 409) return true;
  return /merge conflict/i.test(text);
}

export async function fanInTaskBranches(token: string, input: FanInRepoInput): Promise<FanInResult> {
  const ensured = await ensureRunBranchFromBase(
    token,
    input.owner,
    input.repo,
    input.baseRef,
    input.runBranch,
  );
  if (ensured.error) {
    return { ok: false, conflict: false, error: ensured.error };
  }

  const ordered = topoSortTaskGroup(input.taskIds, input.graph);
  for (const taskId of ordered) {
    const head = input.taskBranchesById[taskId];
    if (!head) {
      return { ok: false, conflict: false, error: `missing task branch for ${taskId}` };
    }
    const merge = await mergeBranches(
      token,
      input.owner,
      input.repo,
      input.runBranch,
      head,
      `Fan-in ${taskId} into ${input.runBranch}`,
    );
    if (!merge.ok) {
      const error = `merge ${head} into ${input.runBranch}: HTTP ${merge.status} ${merge.text.slice(0, 500)}`;
      if (isConflict(merge.status, merge.text)) {
        return { ok: false, conflict: true, error };
      }
      return { ok: false, conflict: false, error };
    }
  }
  return { ok: true };
}
