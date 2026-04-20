import YAML from "yaml";
import type {
  BranchLayout,
  DelegationGroupConfig,
  DelegationMapConfig,
  DelegationPhaseConfig,
  McpHttpAuth,
  McpServerConfig,
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
  const mcpServers = parseMcpServers(r.mcp_servers ?? r.mcpServers);
  return {
    name: (r.name as string) ?? "unnamed",
    model: (r.model as string) ?? "composer-2",
    prompt: (r.prompt as string) ?? "",
    repositories,
    tasks,
    delegation_map: delegationMap,
    target,
    bootstrap_repo_name: (r.bootstrap_repo_name as string) ?? "cursor-orch-bootstrap",
    mcp_servers: mcpServers,
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
  if (config.mcp_servers && Object.keys(config.mcp_servers).length > 0) {
    data.mcp_servers = serializeMcpServers(config.mcp_servers);
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

export function parseMcpServers(raw: unknown): Record<string, McpServerConfig> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("mcp_servers must be a mapping of name to server config");
  }
  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    out[name] = parseMcpServer(name, value);
  }
  return out;
}

function inferMcpType(o: Record<string, unknown>): unknown {
  if (o.type !== undefined) return o.type;
  if (typeof o.command === "string") return "stdio";
  if (typeof o.url === "string") return "http";
  return undefined;
}

function parseMcpServer(name: string, value: unknown): McpServerConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`mcp_servers['${name}'] must be a mapping`);
  }
  const o = value as Record<string, unknown>;
  const rawType = inferMcpType(o);
  if (rawType !== "http" && rawType !== "sse" && rawType !== "stdio") {
    throw new Error(`mcp_servers['${name}'].type must be 'http', 'sse', or 'stdio'`);
  }
  if (rawType === "stdio") {
    if (typeof o.command !== "string" || !o.command.trim()) {
      throw new Error(`mcp_servers['${name}'].command must be a non-empty string`);
    }
    const args = parseStringArray(o.args, `mcp_servers['${name}'].args`);
    const env = parseStringMap(o.env, `mcp_servers['${name}'].env`);
    const cwd = o.cwd === undefined ? undefined : String(o.cwd);
    const entry: McpServerConfig = { type: "stdio", command: o.command };
    if (args !== undefined) entry.args = args;
    if (env !== undefined) entry.env = env;
    if (cwd !== undefined) entry.cwd = cwd;
    return entry;
  }
  if (typeof o.url !== "string" || !o.url.trim()) {
    throw new Error(`mcp_servers['${name}'].url must be a non-empty string`);
  }
  const headers = parseStringMap(o.headers, `mcp_servers['${name}'].headers`);
  const auth = parseMcpAuth(name, o.auth);
  const entry: McpServerConfig = { type: rawType, url: o.url };
  if (headers !== undefined) entry.headers = headers;
  if (auth !== undefined) entry.auth = auth;
  return entry;
}

function parseMcpAuth(name: string, raw: unknown): McpHttpAuth | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`mcp_servers['${name}'].auth must be a mapping`);
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.CLIENT_ID !== "string" || !o.CLIENT_ID.trim()) {
    throw new Error(`mcp_servers['${name}'].auth.CLIENT_ID must be a non-empty string`);
  }
  const auth: McpHttpAuth = { CLIENT_ID: o.CLIENT_ID };
  if (o.CLIENT_SECRET !== undefined && o.CLIENT_SECRET !== null) {
    if (typeof o.CLIENT_SECRET !== "string") {
      throw new Error(`mcp_servers['${name}'].auth.CLIENT_SECRET must be a string`);
    }
    auth.CLIENT_SECRET = o.CLIENT_SECRET;
  }
  if (o.scopes !== undefined && o.scopes !== null) {
    const scopes = parseStringArray(o.scopes, `mcp_servers['${name}'].auth.scopes`);
    if (scopes !== undefined) auth.scopes = scopes;
  }
  return auth;
}

function parseStringArray(raw: unknown, label: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`${label} must be an array of strings`);
  }
  return raw.map((value, index) => {
    if (typeof value !== "string") {
      throw new Error(`${label}[${index}] must be a string`);
    }
    return value;
  });
}

function parseStringMap(raw: unknown, label: string): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} must be a mapping of string to string`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new Error(`${label}['${k}'] must be a string`);
    }
    out[k] = v;
  }
  return out;
}

function serializeMcpServers(servers: Record<string, McpServerConfig>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    out[name] = serializeMcpServer(cfg);
  }
  return out;
}

function serializeMcpServer(cfg: McpServerConfig): Record<string, unknown> {
  if (cfg.type === "stdio") {
    const entry: Record<string, unknown> = { type: cfg.type, command: cfg.command };
    if (cfg.args && cfg.args.length) entry.args = [...cfg.args];
    if (cfg.env && Object.keys(cfg.env).length) entry.env = { ...cfg.env };
    if (cfg.cwd !== undefined) entry.cwd = cfg.cwd;
    return entry;
  }
  const entry: Record<string, unknown> = { type: cfg.type, url: cfg.url };
  if (cfg.headers && Object.keys(cfg.headers).length) entry.headers = { ...cfg.headers };
  if (cfg.auth) {
    const auth: Record<string, unknown> = { CLIENT_ID: cfg.auth.CLIENT_ID };
    if (cfg.auth.CLIENT_SECRET !== undefined) auth.CLIENT_SECRET = cfg.auth.CLIENT_SECRET;
    if (cfg.auth.scopes && cfg.auth.scopes.length) auth.scopes = [...cfg.auth.scopes];
    entry.auth = auth;
  }
  return entry;
}
