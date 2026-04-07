import YAML from "yaml";
import type {
  BranchLayout,
  DelegationGroupConfig,
  DelegationMapConfig,
  DelegationPhaseConfig,
  OrchestratorConfig,
  RepoConfig,
  TargetConfig,
  TaskConfig,
} from "./types.js";

export function parseConfig(yamlStr: string): OrchestratorConfig {
  const raw = YAML.parse(yamlStr) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Config must be a YAML mapping");
  }
  const r = raw as Record<string, unknown>;
  const repositories = parseRepositories((r.repositories as Record<string, unknown>) || {});
  const tasks = parseTasks((r.tasks as unknown[]) || []);
  const delegationMap = parseDelegationMap(r.delegation_map ?? r.delegationMap);
  const target = parseTarget((r.target as Record<string, unknown>) || {});
  return {
    name: (r.name as string) ?? "unnamed",
    model: (r.model as string) ?? "composer-2",
    prompt: (r.prompt as string) ?? "",
    repositories,
    tasks,
    delegation_map: delegationMap,
    target,
    bootstrap_repo_name: (r.bootstrap_repo_name as string) ?? "cursor-orch-bootstrap",
  };
}

export function toYaml(config: OrchestratorConfig): string {
  const data: Record<string, unknown> = {
    name: config.name,
    model: config.model,
  };
  if (config.prompt) {
    data.prompt = config.prompt;
  }
  if (Object.keys(config.repositories).length > 0) {
    data.repositories = Object.fromEntries(
      Object.entries(config.repositories).map(([k, v]) => [k, { url: v.url, ref: v.ref }]),
    );
  }
  if (config.tasks.length > 0) {
    data.tasks = config.tasks.map((t) => {
      const td: Record<string, unknown> = { id: t.id, repo: t.repo, prompt: t.prompt };
      if (t.model !== null) td.model = t.model;
      if (t.depends_on.length) td.depends_on = t.depends_on;
      if (t.timeout_minutes !== 30) td.timeout_minutes = t.timeout_minutes;
      if (t.create_repo) td.create_repo = t.create_repo;
      if (t.repo_config !== null) td.repo_config = t.repo_config;
      return td;
    });
  }
  if (config.delegation_map && config.delegation_map.phases.length > 0) {
    data.delegation_map = {
      phases: config.delegation_map.phases.map((phase) => ({
        id: phase.id,
        groups: phase.groups.map((group) => ({
          id: group.id,
          task_ids: [...group.task_ids],
        })),
      })),
    };
  }
  data.target = {
    auto_create_pr: config.target.auto_create_pr,
    consolidate_prs: config.target.consolidate_prs,
    branch_prefix: config.target.branch_prefix,
    branch_layout: config.target.branch_layout,
  };
  if (config.bootstrap_repo_name !== "cursor-orch-bootstrap") {
    data.bootstrap_repo_name = config.bootstrap_repo_name;
  }
  return YAML.stringify(data, { sortMapEntries: false });
}

function looksLikeGithubRepoHttpsUrl(s: string): boolean {
  return /^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+/.test(s.trim());
}

function normalizeRepoUrlRef(url: string, ref: string | undefined): { url: string; ref: string } {
  const r = ref ?? "main";
  if (looksLikeGithubRepoHttpsUrl(r) && !looksLikeGithubRepoHttpsUrl(url)) {
    return { url: r.trim(), ref: url.trim() || "main" };
  }
  return { url, ref: r };
}

function parseRepositories(raw: Record<string, unknown>): Record<string, RepoConfig> {
  const out: Record<string, RepoConfig> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "object" || v === null) continue;
    const o = v as Record<string, unknown>;
    const rawUrl = o.url !== undefined && o.url !== null ? String(o.url) : "";
    const rawRef = o.ref !== undefined && o.ref !== null ? String(o.ref) : undefined;
    const normalized = normalizeRepoUrlRef(rawUrl, rawRef);
    out[k] = { url: normalized.url, ref: normalized.ref };
  }
  return out;
}

function parseTasks(raw: unknown[]): TaskConfig[] {
  return raw.map((t) => {
    if (typeof t !== "object" || t === null) throw new Error("Invalid task entry");
    const o = t as Record<string, unknown>;
    return {
      id: String(o.id),
      repo: String(o.repo),
      prompt: String(o.prompt),
      model: (o.model as string) ?? null,
      depends_on: (o.depends_on as string[]) ?? [],
      timeout_minutes: typeof o.timeout_minutes === "number" ? o.timeout_minutes : 30,
      create_repo: Boolean(o.create_repo),
      repo_config: (o.repo_config as Record<string, unknown>) ?? null,
    };
  });
}

function parseTarget(raw: Record<string, unknown>): TargetConfig {
  const layoutRaw = raw.branch_layout;
  let branch_layout: BranchLayout = "consolidated";
  if (layoutRaw !== undefined && layoutRaw !== null) {
    branch_layout = String(layoutRaw).trim() as BranchLayout;
  }
  return {
    auto_create_pr: raw.auto_create_pr !== undefined ? Boolean(raw.auto_create_pr) : true,
    consolidate_prs: raw.consolidate_prs !== undefined ? Boolean(raw.consolidate_prs) : true,
    branch_prefix: (raw.branch_prefix as string) ?? "cursor-orch",
    branch_layout,
  };
}

function parseDelegationMap(raw: unknown): DelegationMapConfig | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const source = raw as Record<string, unknown>;
  const phasesRaw = source.phases;
  if (!Array.isArray(phasesRaw)) {
    return null;
  }
  const phases: DelegationPhaseConfig[] = phasesRaw
    .map((entry, index) => parseDelegationPhase(entry, index))
    .filter((phase): phase is DelegationPhaseConfig => phase !== null);
  return { phases };
}

function parseDelegationPhase(raw: unknown, index: number): DelegationPhaseConfig | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const source = raw as Record<string, unknown>;
  const id = stringifyOrFallback(source.id ?? source.name ?? source.phase ?? source.phase_id, `phase-${index + 1}`);
  const groups = parseDelegationGroups(source.groups ?? source.parallel_groups ?? source.parallelGroups);
  return { id, groups };
}

function parseDelegationGroups(raw: unknown): DelegationGroupConfig[] {
  if (Array.isArray(raw)) {
    return raw
      .map((entry, index) => parseDelegationGroup(entry, index))
      .filter((group): group is DelegationGroupConfig => group !== null);
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .map(([groupId, value], index) => parseDelegationGroup({ id: groupId, task_ids: value }, index))
      .filter((group): group is DelegationGroupConfig => group !== null);
  }
  return [];
}

function parseDelegationGroup(raw: unknown, index: number): DelegationGroupConfig | null {
  if (Array.isArray(raw)) {
    return {
      id: `group-${index + 1}`,
      task_ids: parseTaskIds(raw),
    };
  }
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const source = raw as Record<string, unknown>;
  const id = stringifyOrFallback(source.id ?? source.name ?? source.group ?? source.group_id, `group-${index + 1}`);
  const taskIdsRaw = source.task_ids ?? source.taskIds ?? source.tasks;
  return {
    id,
    task_ids: parseTaskIds(taskIdsRaw),
  };
}

function parseTaskIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0);
}

function stringifyOrFallback(value: unknown, fallback: string): string {
  const normalized = value === null || value === undefined ? "" : String(value).trim();
  return normalized || fallback;
}
