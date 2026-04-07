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

export interface OrchestratorConfig {
  name: string;
  model: string;
  prompt: string;
  repositories: Record<string, RepoConfig>;
  tasks: TaskConfig[];
  delegation_map?: DelegationMapConfig | null;
  target: TargetConfig;
  bootstrap_repo_name: string;
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
