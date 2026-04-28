import type { DelegationMapConfig, OrchestratorConfig, RepoConfig, TaskConfig } from "./types.js";
import { buildRepoTokenIndex, normalizeRepoToken, resolveRepoTarget } from "../lib/repo-target.js";

const BOOTSTRAP_KEY = "__bootstrap__";

function resolveRepoAliasToKey(
  requestedRepo: string,
  repositories: Record<string, RepoConfig>,
  tokenIndex: Map<string, Set<string>>,
): string | null {
  if (requestedRepo in repositories) {
    return requestedRepo;
  }
  const matches = tokenIndex.get(normalizeRepoToken(requestedRepo));
  if (!matches || matches.size !== 1) {
    return null;
  }
  return [...matches][0] ?? null;
}

export function canonicalizeOrchestratorConfig(config: OrchestratorConfig): OrchestratorConfig {
  const repos = config.repositories;
  const bootstrap = repos[BOOTSTRAP_KEY];
  const work: Record<string, RepoConfig> = { ...repos };
  delete work[BOOTSTRAP_KEY];

  const newRepos: Record<string, RepoConfig> = {};
  for (const [entryKey, rc] of Object.entries(work)) {
    const resolved = resolveRepoTarget(rc.url, repos, rc.ref);
    if (!resolved) {
      throw new Error(`repositories entry '${entryKey}' has url '${rc.url}' that cannot be resolved`);
    }
    const [canonicalUrl, ref] = resolved;
    const existing = newRepos[canonicalUrl];
    if (existing && existing.ref !== ref) {
      throw new Error(`Conflicting ref for repository ${canonicalUrl}: '${existing.ref}' vs '${ref}'`);
    }
    newRepos[canonicalUrl] = { url: canonicalUrl, ref };
  }
  if (bootstrap) {
    newRepos[BOOTSTRAP_KEY] = bootstrap;
  }

  const tokenIndex = buildRepoTokenIndex(repos);
  const newTasks: TaskConfig[] = config.tasks.map((t) => {
    if (t.create_repo || t.repo === "__new__") {
      return { ...t };
    }
    const key = resolveRepoAliasToKey(t.repo, repos, tokenIndex);
    if (!key) {
      throw new Error(`Task '${t.id}' references unknown repository '${t.repo}'`);
    }
    const rc = repos[key]!;
    const resolved = resolveRepoTarget(rc.url, repos, rc.ref);
    if (!resolved) {
      throw new Error(`Task '${t.id}' repository '${t.repo}' could not be resolved`);
    }
    const [canonicalUrl] = resolved;
    return { ...t, repo: canonicalUrl };
  });

  const delegationMap = canonicalizeDelegationMap(config.delegation_map ?? null);

  return {
    ...config,
    repositories: newRepos,
    tasks: newTasks,
    delegation_map: delegationMap,
    inventory: config.inventory == null ? null : { ...config.inventory },
  };
}

function canonicalizeDelegationMap(raw: DelegationMapConfig | null): DelegationMapConfig | null {
  if (!raw) {
    return null;
  }
  return {
    phases: raw.phases.map((phase) => ({
      id: String(phase.id).trim(),
      groups: phase.groups.map((group) => ({
        id: String(group.id).trim(),
        task_ids: group.task_ids.map((taskId) => String(taskId).trim()),
      })),
    })),
  };
}
