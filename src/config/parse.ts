import YAML from "yaml";
import type { OrchestratorConfig, RepoConfig, TargetConfig, TaskConfig } from "./types.js";

export function parseConfig(yamlStr: string): OrchestratorConfig {
  const raw = YAML.parse(yamlStr) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Config must be a YAML mapping");
  }
  const r = raw as Record<string, unknown>;
  const repositories = parseRepositories((r.repositories as Record<string, unknown>) || {});
  const tasks = parseTasks((r.tasks as unknown[]) || []);
  const target = parseTarget((r.target as Record<string, unknown>) || {});
  return {
    name: (r.name as string) ?? "unnamed",
    model: (r.model as string) ?? "default",
    prompt: (r.prompt as string) ?? "",
    repositories,
    tasks,
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
  data.target = {
    auto_create_pr: config.target.auto_create_pr,
    branch_prefix: config.target.branch_prefix,
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
  return {
    auto_create_pr: raw.auto_create_pr !== undefined ? Boolean(raw.auto_create_pr) : true,
    branch_prefix: (raw.branch_prefix as string) ?? "cursor-orch",
  };
}
