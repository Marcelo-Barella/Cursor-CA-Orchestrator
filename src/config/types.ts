export type SourceType = "flag" | "env" | "project" | "session" | "default" | "unset";

export interface RepoConfig {
  url: string;
  ref: string;
}

export interface TaskConfig {
  id: string;
  repo: string;
  prompt: string;
  model: string | null;
  depends_on: string[];
  timeout_minutes: number;
  create_repo: boolean;
  repo_config: Record<string, unknown> | null;
}

export type BranchLayout = "consolidated" | "per_task";

export type InventorySource = "declared" | "discovered" | "merged";

export type ProductClass = "web_app" | "api" | "library" | "static_site";

export type InventoryRepoEntry = {
  role?: string;
  has_server?: boolean;
  has_db?: boolean;
};

export type InventoryRepoHints = Record<string, InventoryRepoEntry>;

export interface InventoryManifestV1 {
  version: 1;
  source: InventorySource;
  product_class: ProductClass;
  layers: string[];
  explicit_deferrals: string[];
  required_integrations: string[];
  repo_hints?: InventoryRepoHints;
  greenfield: boolean;
}

export interface TargetConfig {
  auto_create_pr: boolean;
  consolidate_prs: boolean;
  branch_prefix: string;
  branch_layout: BranchLayout;
}

export interface DelegationGroupConfig {
  id: string;
  task_ids: string[];
}

export interface DelegationPhaseConfig {
  id: string;
  groups: DelegationGroupConfig[];
}

export interface DelegationMapConfig {
  phases: DelegationPhaseConfig[];
}

export type McpStdioConfig = {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type McpHttpAuth = {
  CLIENT_ID: string;
  CLIENT_SECRET?: string;
  scopes?: string[];
};

export type McpHttpConfig = {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  auth?: McpHttpAuth;
};

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface OrchestratorConfig {
  name: string;
  model: string;
  prompt: string;
  repositories: Record<string, RepoConfig>;
  tasks: TaskConfig[];
  delegation_map?: DelegationMapConfig | null;
  target: TargetConfig;
  bootstrap_repo_name: string;
  mcp_servers?: Record<string, McpServerConfig>;
  inventory?: InventoryManifestV1 | null;
}

export interface ResolvedValue {
  value: unknown;
  source: SourceType;
  source_ref: string;
}

export type FindingSeverity = "error" | "warn" | "info";
export type FindingCategory =
  | "usage"
  | "environment"
  | "config"
  | "validation"
  | "conflict"
  | "session"
  | "system";

export interface DiagnosticFinding {
  code: string;
  severity: FindingSeverity;
  category: FindingCategory;
  message: string;
  field: string;
  source: SourceType;
  source_ref: string;
  expected: string;
  actual: string;
  why_it_failed: string;
  fix: string;
  is_blocking: boolean;
  suggested_commands: string[];
  docs_ref: string | null;
  details: Record<string, unknown> | null;
}

export interface ConfigResolution {
  config: OrchestratorConfig;
  provenance: Record<string, ResolvedValue>;
  findings: DiagnosticFinding[];
}
