import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";
import { parseConfig } from "./parse.js";
import type {
  BranchLayout,
  ConfigResolution,
  DelegationMapConfig,
  DiagnosticFinding,
  OrchestratorConfig,
  RepoConfig,
  ResolvedValue,
  TaskConfig,
} from "./types.js";
import { validateConfig } from "./validate.js";

function finding(
  partial: Omit<DiagnosticFinding, "suggested_commands" | "docs_ref" | "details"> & {
    suggested_commands?: string[];
    docs_ref?: string | null;
    details?: Record<string, unknown> | null;
  },
): DiagnosticFinding {
  return {
    suggested_commands: partial.suggested_commands ?? [],
    docs_ref: partial.docs_ref ?? null,
    details: partial.details ?? null,
    ...partial,
  };
}

function resolveConfigPath(configPathFlag: string | null | undefined, findings: DiagnosticFinding[]): ResolvedValue {
  const cwdDefault = path.join(process.cwd(), ".cursor-orch.yaml");
  if (configPathFlag !== undefined && configPathFlag !== null && configPathFlag.trim()) {
    return { value: configPathFlag.trim(), source: "flag", source_ref: "--config" };
  }
  const envConfig = process.env.CURSOR_ORCH_CONFIG;
  if (envConfig !== undefined && envConfig.trim()) {
    return { value: envConfig.trim(), source: "env", source_ref: "CURSOR_ORCH_CONFIG" };
  }
  if (fs.existsSync(cwdDefault)) {
    return { value: cwdDefault, source: "default", source_ref: ".cursor-orch.yaml" };
  }
  findings.push(
    finding({
      code: "CFG_REQUIRED_MISSING",
      severity: "error",
      category: "usage",
      message: "No configuration source found.",
      field: "config_path",
      source: "unset",
      source_ref: "config_path",
      expected: "one of: --config, CURSOR_ORCH_CONFIG, or .cursor-orch.yaml present",
      actual: "unset",
      why_it_failed: "Run command requires a project configuration source.",
      fix: "Provide a config path explicitly or create `.cursor-orch.yaml`.",
      is_blocking: true,
      suggested_commands: ["cursor-orch run --config ./config.yaml", "export CURSOR_ORCH_CONFIG=./config.yaml"],
      docs_ref: "README#onboarding-clone-to-first-run",
    }),
  );
  return { value: null, source: "unset", source_ref: "unset" };
}

function loadSourceConfig(
  configPathValue: ResolvedValue,
  findings: DiagnosticFinding[],
): { config: OrchestratorConfig | null; raw: Record<string, unknown> | null } {
  const configPath = configPathValue.value;
  if (typeof configPath !== "string") {
    return { config: null, raw: null };
  }
  if (!fs.existsSync(configPath)) {
    findings.push(
      finding({
        code: "CFG_FILE_NOT_FOUND",
        severity: "error",
        category: "config",
        message: `Config file not found: ${configPath}.`,
        field: "config_path",
        source: configPathValue.source,
        source_ref: configPathValue.source_ref,
        expected: "existing readable YAML file",
        actual: "missing path",
        why_it_failed: "Selected config path does not exist.",
        fix: "Update `--config` or CURSOR_ORCH_CONFIG to a valid file path.",
        is_blocking: true,
        suggested_commands: [
          "cursor-orch config doctor --config ./config.yaml --strict",
          "cursor-orch run --config ./config.yaml",
        ],
        docs_ref: "README#onboarding-clone-to-first-run",
      }),
    );
    return { config: null, raw: null };
  }
  let content: string;
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch {
    findings.push(
      finding({
        code: "CFG_FILE_UNREADABLE",
        severity: "error",
        category: "system",
        message: `Cannot read config file: ${configPath}.`,
        field: "config_path",
        source: configPathValue.source,
        source_ref: configPathValue.source_ref,
        expected: "readable file",
        actual: "unreadable",
        why_it_failed: "File permissions or filesystem state prevented reading the file.",
        fix: "Fix file permissions and rerun `cursor-orch config doctor --strict`.",
        is_blocking: true,
        suggested_commands: ["ls -l ./config.yaml", "cursor-orch config doctor --config ./config.yaml --strict"],
        docs_ref: "README#onboarding-clone-to-first-run",
      }),
    );
    return { config: null, raw: null };
  }
  let raw: unknown;
  try {
    raw = YAML.parse(content);
  } catch (exc) {
    findings.push(
      finding({
        code: "CFG_YAML_INVALID",
        severity: "error",
        category: "validation",
        message: `Invalid YAML in config file: ${exc}.`,
        field: "config",
        source: "project",
        source_ref: configPath,
        expected: "valid YAML mapping",
        actual: "parse failure",
        why_it_failed: "YAML parsing failed before schema validation.",
        fix: "Fix YAML syntax and rerun `cursor-orch config doctor --strict`.",
        is_blocking: true,
        suggested_commands: ["cursor-orch config doctor --config ./config.yaml --strict"],
        docs_ref: "README#onboarding-clone-to-first-run",
      }),
    );
    return { config: null, raw: null };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    findings.push(
      finding({
        code: "CFG_SCHEMA_INVALID",
        severity: "error",
        category: "validation",
        message: "Config root must be a YAML mapping.",
        field: "config",
        source: "project",
        source_ref: configPath,
        expected: "mapping",
        actual: typeof raw,
        why_it_failed: "Config parser requires top-level mapping keys.",
        fix: "Rewrite config root as key-value mapping and rerun doctor.",
        is_blocking: true,
        suggested_commands: ["cursor-orch config doctor --config ./config.yaml --strict"],
        docs_ref: "README#onboarding-clone-to-first-run",
      }),
    );
    return { config: null, raw: null };
  }
  try {
    const absConfig = path.resolve(configPath);
    const parsed = parseConfig(content, { inventoryBaseDir: path.dirname(absConfig) });
    return { config: parsed, raw: raw as Record<string, unknown> };
  } catch (exc) {
    findings.push(
      finding({
        code: "CFG_SCHEMA_INVALID",
        severity: "error",
        category: "validation",
        message: String(exc),
        field: "config",
        source: "project",
        source_ref: configPath,
        expected: "valid config keys and value types",
        actual: "invalid shape",
        why_it_failed: "Config format could not be normalized to internal model.",
        fix: "Correct the configuration file and rerun doctor.",
        is_blocking: true,
        suggested_commands: ["cursor-orch config doctor --config ./config.yaml --strict"],
        docs_ref: "README#onboarding-clone-to-first-run",
      }),
    );
    return { config: null, raw: null };
  }
}

function loadSessionConfig(findings: DiagnosticFinding[]): { config: OrchestratorConfig | null; raw: Record<string, unknown> | null } {
  const sessionPath = path.join(os.homedir(), ".cursor-orch", "session.yaml");
  if (!fs.existsSync(sessionPath)) {
    return { config: null, raw: null };
  }
  let content: string;
  try {
    content = fs.readFileSync(sessionPath, "utf8");
  } catch {
    findings.push(
      finding({
        code: "CFG_SESSION_UNREADABLE",
        severity: "warn",
        category: "session",
        message: "Session file is unreadable and will be ignored.",
        field: "session",
        source: "session",
        source_ref: sessionPath,
        expected: "readable session file",
        actual: "unreadable",
        why_it_failed: "Session fallback could not be loaded from disk.",
        fix: "Fix session permissions or remove the broken file.",
        is_blocking: false,
        suggested_commands: [`rm ${sessionPath}`],
        docs_ref: "README#onboarding-clone-to-first-run",
      }),
    );
    return { config: null, raw: null };
  }
  try {
    const raw = YAML.parse(content);
    if (raw === null || raw === undefined) {
      return { config: null, raw: null };
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("session root must be mapping");
    }
    const absSession = path.resolve(sessionPath);
    const parsed = parseConfig(content, { inventoryBaseDir: path.dirname(absSession) });
    return { config: parsed, raw: raw as Record<string, unknown> };
  } catch {
    findings.push(
      finding({
        code: "CFG_SESSION_INVALID",
        severity: "warn",
        category: "session",
        message: "Session file is invalid and will be ignored.",
        field: "session",
        source: "session",
        source_ref: sessionPath,
        expected: "valid session yaml",
        actual: "invalid",
        why_it_failed: "Session fallback cannot be merged because values are invalid.",
        fix: "Remove or repair the session file before relying on session fallback.",
        is_blocking: false,
        suggested_commands: [`rm ${sessionPath}`],
        docs_ref: "README#onboarding-clone-to-first-run",
      }),
    );
    return { config: null, raw: null };
  }
}

function getNested(raw: Record<string, unknown> | null | undefined, keyPath: string[]): [unknown, boolean] {
  if (!raw) return [undefined, false];
  let current: unknown = raw;
  for (const segment of keyPath) {
    if (typeof current !== "object" || current === null || !(segment in current)) {
      return [undefined, false];
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return [current, true];
}

function parseBool(value: string): boolean | null {
  const n = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(n)) return true;
  if (["0", "false", "no", "off"].includes(n)) return false;
  return null;
}

function selectWithConflict(fieldName: string, candidates: ResolvedValue[], findings: DiagnosticFinding[]): ResolvedValue {
  const winner = candidates[0]!;
  const losers = candidates.slice(1).filter((c) => JSON.stringify(c.value) !== JSON.stringify(winner.value));
  if (losers.length) {
    findings.push(
      finding({
        code: "CFG_CONFLICT_RESOLVED",
        severity: "info",
        category: "conflict",
        message: `Multiple sources provided ${fieldName}; highest precedence source won.`,
        field: fieldName,
        source: winner.source,
        source_ref: winner.source_ref,
        expected: String(winner.value),
        actual: losers.map((item) => `${item.source}:${String(item.value)}`).join(", "),
        why_it_failed: "Lower-precedence values were overridden by precedence rules.",
        fix: `Use higher-precedence source explicitly or remove stale lower-precedence values for ${fieldName}.`,
        is_blocking: false,
        suggested_commands: [],
        docs_ref: "README#onboarding-clone-to-first-run",
      }),
    );
  }
  return winner;
}

function resolveStringValue(
  opts: {
    fieldName: string;
    defaultValue: string;
    flagValue: string | null | undefined;
    flagRef: string;
    envName: string;
    projectRaw: Record<string, unknown> | null;
    projectKeyPath: string[];
    projectRef: string;
    sessionRaw: Record<string, unknown> | null;
    sessionKeyPath: string[];
    sessionRef: string;
    findings: DiagnosticFinding[];
  },
): ResolvedValue {
  const candidates: ResolvedValue[] = [];
  if (opts.flagValue !== undefined && opts.flagValue !== null && opts.flagValue.trim()) {
    candidates.push({ value: opts.flagValue.trim(), source: "flag", source_ref: opts.flagRef });
  }
  const envValue = process.env[opts.envName];
  if (envValue !== undefined) {
    if (envValue.trim()) {
      candidates.push({ value: envValue.trim(), source: "env", source_ref: opts.envName });
    } else {
      opts.findings.push(
        finding({
          code: "CFG_ENV_EMPTY_IGNORED",
          severity: "warn",
          category: "environment",
          message: `Environment variable ${opts.envName} is set but empty and will be ignored.`,
          field: opts.fieldName,
          source: "env",
          source_ref: opts.envName,
          expected: "non-empty string",
          actual: "empty",
          why_it_failed: "Empty env values are treated as unset during precedence resolution.",
          fix: `Unset \`${opts.envName}\` or provide a non-empty value before running command again.`,
          is_blocking: false,
          suggested_commands: [`unset ${opts.envName}`, `export ${opts.envName}=<value>`, "cursor-orch config doctor --strict"],
          docs_ref: "README#onboarding-clone-to-first-run",
        }),
      );
    }
  }
  const [projectValue, projectExists] = getNested(opts.projectRaw, opts.projectKeyPath);
  if (projectExists) {
    if (typeof projectValue === "string" && projectValue.trim()) {
      candidates.push({ value: projectValue.trim(), source: "project", source_ref: opts.projectRef });
    } else {
      opts.findings.push(
        finding({
          code: "CFG_VALUE_INVALID",
          severity: "error",
          category: "config",
          message: `Invalid empty value for ${opts.fieldName}.`,
          field: opts.fieldName,
          source: "project",
          source_ref: opts.projectRef,
          expected: "non-empty string",
          actual: "empty or non-string",
          why_it_failed: "Project config values for this field must be a non-empty string.",
          fix: `Set a non-empty value for \`${opts.fieldName}\` in project config.`,
          is_blocking: true,
          suggested_commands: ["cursor-orch config doctor --strict"],
          docs_ref: "README#onboarding-clone-to-first-run",
        }),
      );
    }
  }
  const [sessionValue, sessionExists] = getNested(opts.sessionRaw, opts.sessionKeyPath);
  if (sessionExists) {
    if (typeof sessionValue === "string" && sessionValue.trim()) {
      candidates.push({ value: sessionValue.trim(), source: "session", source_ref: opts.sessionRef });
    } else {
      opts.findings.push(
        finding({
          code: "CFG_SESSION_INVALID",
          severity: "warn",
          category: "session",
          message: `Session value for ${opts.fieldName} is invalid and ignored.`,
          field: opts.fieldName,
          source: "session",
          source_ref: opts.sessionRef,
          expected: "non-empty string",
          actual: "empty or non-string",
          why_it_failed: "Session fallback was present but invalid.",
          fix: `Fix or remove session value for \`${opts.fieldName}\`.`,
          is_blocking: false,
          suggested_commands: ["cursor-orch config doctor --strict"],
          docs_ref: "README#onboarding-clone-to-first-run",
        }),
      );
    }
  }
  candidates.push({ value: opts.defaultValue, source: "default", source_ref: `default:${opts.fieldName}` });
  return selectWithConflict(opts.fieldName, candidates, opts.findings);
}

function resolveBoolValue(opts: {
  fieldName: string;
  defaultValue: boolean;
  envName: string;
  projectRaw: Record<string, unknown> | null;
  projectKeyPath: string[];
  projectRef: string;
  sessionRaw: Record<string, unknown> | null;
  sessionKeyPath: string[];
  sessionRef: string;
  findings: DiagnosticFinding[];
}): ResolvedValue {
  const candidates: ResolvedValue[] = [];
  const envRaw = process.env[opts.envName];
  if (envRaw !== undefined) {
    if (envRaw.trim()) {
      const parsed = parseBool(envRaw);
      if (parsed === null) {
        opts.findings.push(
          finding({
            code: "CFG_VALUE_INVALID",
            severity: "error",
            category: "environment",
            message: `Invalid boolean in ${opts.envName}.`,
            field: opts.fieldName,
            source: "env",
            source_ref: opts.envName,
            expected: "true|false|1|0|yes|no|on|off",
            actual: envRaw,
            why_it_failed: "Boolean environment value could not be parsed.",
            fix: `Set \`${opts.envName}\` to a valid boolean string.`,
            is_blocking: true,
            suggested_commands: [`export ${opts.envName}=true`, "cursor-orch config doctor --strict"],
            docs_ref: "README#onboarding-clone-to-first-run",
          }),
        );
      } else {
        candidates.push({ value: parsed, source: "env", source_ref: opts.envName });
      }
    } else {
      opts.findings.push(
        finding({
          code: "CFG_ENV_EMPTY_IGNORED",
          severity: "warn",
          category: "environment",
          message: `Environment variable ${opts.envName} is set but empty and will be ignored.`,
          field: opts.fieldName,
          source: "env",
          source_ref: opts.envName,
          expected: "true|false|1|0|yes|no|on|off",
          actual: "empty",
          why_it_failed: "Empty env values are treated as unset during precedence resolution.",
          fix: `Unset \`${opts.envName}\` or set it to a valid boolean value.`,
          is_blocking: false,
          suggested_commands: [`unset ${opts.envName}`, `export ${opts.envName}=true`, "cursor-orch config doctor --strict"],
          docs_ref: "README#onboarding-clone-to-first-run",
        }),
      );
    }
  }
  const [projectValue, projectExists] = getNested(opts.projectRaw, opts.projectKeyPath);
  if (projectExists) {
    if (typeof projectValue === "boolean") {
      candidates.push({ value: projectValue, source: "project", source_ref: opts.projectRef });
    } else {
      opts.findings.push(
        finding({
          code: "CFG_VALUE_INVALID",
          severity: "error",
          category: "config",
          message: `Invalid boolean value for ${opts.fieldName} in project config.`,
          field: opts.fieldName,
          source: "project",
          source_ref: opts.projectRef,
          expected: "boolean true or false",
          actual: typeof projectValue,
          why_it_failed: "Project configuration uses incorrect type.",
          fix: `Set \`${opts.fieldName}\` to true or false in config file.`,
          is_blocking: true,
          suggested_commands: ["cursor-orch config doctor --strict"],
          docs_ref: "README#onboarding-clone-to-first-run",
        }),
      );
    }
  }
  const [sessionValue, sessionExists] = getNested(opts.sessionRaw, opts.sessionKeyPath);
  if (sessionExists) {
    if (typeof sessionValue === "boolean") {
      candidates.push({ value: sessionValue, source: "session", source_ref: opts.sessionRef });
    } else {
      opts.findings.push(
        finding({
          code: "CFG_SESSION_INVALID",
          severity: "warn",
          category: "session",
          message: `Session boolean value for ${opts.fieldName} is invalid and ignored.`,
          field: opts.fieldName,
          source: "session",
          source_ref: opts.sessionRef,
          expected: "boolean true or false",
          actual: typeof sessionValue,
          why_it_failed: "Session fallback value has invalid type.",
          fix: `Fix or remove session value for \`${opts.fieldName}\`.`,
          is_blocking: false,
          suggested_commands: ["cursor-orch config doctor --strict"],
          docs_ref: "README#onboarding-clone-to-first-run",
        }),
      );
    }
  }
  candidates.push({ value: opts.defaultValue, source: "default", source_ref: `default:${opts.fieldName}` });
  return selectWithConflict(opts.fieldName, candidates, opts.findings);
}

function resolveRequiredSecret(name: string, findings: DiagnosticFinding[]): ResolvedValue {
  if (!(name in process.env)) {
    findings.push(
      finding({
        code: "CFG_ENV_MISSING",
        severity: "error",
        category: "environment",
        message: `Required environment variable ${name} is missing.`,
        field: name,
        source: "unset",
        source_ref: name,
        expected: "non-empty token",
        actual: "unset",
        why_it_failed: `${name} is required for runtime API operations.`,
        fix: `Set \`${name}\` in shell or \`.env\`, then rerun \`cursor-orch config doctor --strict\`.`,
        is_blocking: true,
        suggested_commands: ["cp .env.example .env", `export ${name}=<value>`, "cursor-orch config doctor --strict"],
        docs_ref: "README#onboarding-clone-to-first-run",
      }),
    );
    return { value: "", source: "unset", source_ref: name };
  }
  const value = process.env[name] ?? "";
  if (!value.trim()) {
    findings.push(
      finding({
        code: "CFG_ENV_EMPTY",
        severity: "error",
        category: "environment",
        message: `Required environment variable ${name} is empty.`,
        field: name,
        source: "unset",
        source_ref: name,
        expected: "non-empty token",
        actual: "empty",
        why_it_failed: `Empty credential values are treated as unset; ${name} must contain a token.`,
        fix: `Set \`${name}\` to a non-empty token and rerun \`cursor-orch config doctor --strict\`.`,
        is_blocking: true,
        suggested_commands: [`export ${name}=<value>`, "cursor-orch config doctor --strict"],
        docs_ref: "README#onboarding-clone-to-first-run",
      }),
    );
    return { value: "", source: "unset", source_ref: name };
  }
  return { value, source: "env", source_ref: name };
}

function resolveRepositories(
  projectConfig: OrchestratorConfig | null,
  projectRaw: Record<string, unknown> | null,
  sessionConfig: OrchestratorConfig | null,
  sessionRaw: Record<string, unknown> | null,
  projectSourceRef: string,
): [Record<string, RepoConfig>, ResolvedValue] {
  if (projectConfig && projectRaw && "repositories" in projectRaw) {
    return [
      projectConfig.repositories,
      { value: Object.keys(projectConfig.repositories).length, source: "project", source_ref: `${projectSourceRef}:repositories` },
    ];
  }
  if (sessionConfig && sessionRaw && "repositories" in sessionRaw) {
    return [
      sessionConfig.repositories,
      { value: Object.keys(sessionConfig.repositories).length, source: "session", source_ref: "~/.cursor-orch/session.yaml:repositories" },
    ];
  }
  return [{}, { value: 0, source: "default", source_ref: "default:repositories" }];
}

function resolveTasks(
  projectConfig: OrchestratorConfig | null,
  projectRaw: Record<string, unknown> | null,
  sessionConfig: OrchestratorConfig | null,
  sessionRaw: Record<string, unknown> | null,
  projectSourceRef: string,
): [TaskConfig[], ResolvedValue] {
  if (projectConfig && projectRaw && "tasks" in projectRaw) {
    return [
      projectConfig.tasks,
      { value: projectConfig.tasks.length, source: "project", source_ref: `${projectSourceRef}:tasks` },
    ];
  }
  if (sessionConfig && sessionRaw && "tasks" in sessionRaw) {
    return [
      sessionConfig.tasks,
      { value: sessionConfig.tasks.length, source: "session", source_ref: "~/.cursor-orch/session.yaml:tasks" },
    ];
  }
  return [[], { value: 0, source: "default", source_ref: "default:tasks" }];
}

function resolveDelegationMap(
  projectConfig: OrchestratorConfig | null,
  projectRaw: Record<string, unknown> | null,
  sessionConfig: OrchestratorConfig | null,
  sessionRaw: Record<string, unknown> | null,
  projectSourceRef: string,
): [DelegationMapConfig | null, ResolvedValue] {
  if (projectConfig && projectRaw && ("delegation_map" in projectRaw || "delegationMap" in projectRaw)) {
    const dm = projectConfig.delegation_map ?? null;
    return [
      dm,
      {
        value: dm?.phases?.length ?? 0,
        source: "project",
        source_ref: `${projectSourceRef}:delegation_map`,
      },
    ];
  }
  if (sessionConfig && sessionRaw && ("delegation_map" in sessionRaw || "delegationMap" in sessionRaw)) {
    const dm = sessionConfig.delegation_map ?? null;
    return [
      dm,
      {
        value: dm?.phases?.length ?? 0,
        source: "session",
        source_ref: "~/.cursor-orch/session.yaml:delegation_map",
      },
    ];
  }
  return [null, { value: 0, source: "default", source_ref: "default:delegation_map" }];
}

export function resolveConfigPrecedence(configPathFlag: string | null | undefined, bootstrapRepoFlag: string | null | undefined): ConfigResolution {
  const findings: DiagnosticFinding[] = [];
  const provenance: Record<string, ResolvedValue> = {};

  const configPathValue = resolveConfigPath(configPathFlag, findings);
  provenance.config_path = configPathValue;

  const { config: projectConfig, raw: projectRaw } = loadSourceConfig(configPathValue, findings);
  const { config: sessionConfig, raw: sessionRaw } = loadSessionConfig(findings);

  const configPathRef =
    typeof configPathValue.value === "string" ? configPathValue.value : configPathValue.source_ref;

  const bootstrapRepo = resolveStringValue({
    fieldName: "bootstrap_repo_name",
    defaultValue: "cursor-orch-bootstrap",
    flagValue: bootstrapRepoFlag,
    flagRef: "--bootstrap-repo",
    envName: "CURSOR_ORCH_BOOTSTRAP_REPO",
    projectRaw,
    projectKeyPath: ["bootstrap_repo_name"],
    projectRef: `${configPathRef}:bootstrap_repo_name`,
    sessionRaw,
    sessionKeyPath: ["bootstrap_repo_name"],
    sessionRef: "~/.cursor-orch/session.yaml:bootstrap_repo_name",
    findings,
  });
  provenance.bootstrap_repo_name = bootstrapRepo;

  const model = resolveStringValue({
    fieldName: "model",
    defaultValue: "composer-2",
    flagValue: null,
    flagRef: "",
    envName: "CURSOR_ORCH_MODEL",
    projectRaw,
    projectKeyPath: ["model"],
    projectRef: `${configPathRef}:model`,
    sessionRaw,
    sessionKeyPath: ["model"],
    sessionRef: "~/.cursor-orch/session.yaml:model",
    findings,
  });
  provenance.model = model;

  const name = resolveStringValue({
    fieldName: "name",
    defaultValue: "unnamed",
    flagValue: null,
    flagRef: "",
    envName: "CURSOR_ORCH_NAME",
    projectRaw,
    projectKeyPath: ["name"],
    projectRef: `${configPathRef}:name`,
    sessionRaw,
    sessionKeyPath: ["name"],
    sessionRef: "~/.cursor-orch/session.yaml:name",
    findings,
  });
  provenance.name = name;

  const prompt = resolveStringValue({
    fieldName: "prompt",
    defaultValue: "",
    flagValue: null,
    flagRef: "",
    envName: "CURSOR_ORCH_PROMPT",
    projectRaw,
    projectKeyPath: ["prompt"],
    projectRef: `${configPathRef}:prompt`,
    sessionRaw,
    sessionKeyPath: ["prompt"],
    sessionRef: "~/.cursor-orch/session.yaml:prompt",
    findings,
  });
  provenance.prompt = prompt;

  const autoPr = resolveBoolValue({
    fieldName: "target.auto_create_pr",
    defaultValue: true,
    envName: "CURSOR_ORCH_AUTO_PR",
    projectRaw,
    projectKeyPath: ["target", "auto_create_pr"],
    projectRef: `${configPathRef}:target.auto_create_pr`,
    sessionRaw,
    sessionKeyPath: ["target", "auto_create_pr"],
    sessionRef: "~/.cursor-orch/session.yaml:target.auto_create_pr",
    findings,
  });
  provenance["target.auto_create_pr"] = autoPr;

  const branchPrefix = resolveStringValue({
    fieldName: "target.branch_prefix",
    defaultValue: "cursor-orch",
    flagValue: null,
    flagRef: "",
    envName: "CURSOR_ORCH_BRANCH_PREFIX",
    projectRaw,
    projectKeyPath: ["target", "branch_prefix"],
    projectRef: `${configPathRef}:target.branch_prefix`,
    sessionRaw,
    sessionKeyPath: ["target", "branch_prefix"],
    sessionRef: "~/.cursor-orch/session.yaml:target.branch_prefix",
    findings,
  });
  provenance["target.branch_prefix"] = branchPrefix;

  const branchLayout = resolveStringValue({
    fieldName: "target.branch_layout",
    defaultValue: "consolidated",
    flagValue: null,
    flagRef: "",
    envName: "CURSOR_ORCH_BRANCH_LAYOUT",
    projectRaw,
    projectKeyPath: ["target", "branch_layout"],
    projectRef: `${configPathRef}:target.branch_layout`,
    sessionRaw,
    sessionKeyPath: ["target", "branch_layout"],
    sessionRef: "~/.cursor-orch/session.yaml:target.branch_layout",
    findings,
  });
  provenance["target.branch_layout"] = branchLayout;

  const consolidatePrs = resolveBoolValue({
    fieldName: "target.consolidate_prs",
    defaultValue: true,
    envName: "CURSOR_ORCH_CONSOLIDATE_PRS",
    projectRaw,
    projectKeyPath: ["target", "consolidate_prs"],
    projectRef: `${configPathRef}:target.consolidate_prs`,
    sessionRaw,
    sessionKeyPath: ["target", "consolidate_prs"],
    sessionRef: "~/.cursor-orch/session.yaml:target.consolidate_prs",
    findings,
  });
  provenance["target.consolidate_prs"] = consolidatePrs;

  const [repositories, repositoriesSource] = resolveRepositories(projectConfig, projectRaw, sessionConfig, sessionRaw, configPathRef);
  provenance.repositories = repositoriesSource;

  const [tasks, tasksSource] = resolveTasks(projectConfig, projectRaw, sessionConfig, sessionRaw, configPathRef);
  provenance.tasks = tasksSource;

  const [delegation_map, delegationMapSource] = resolveDelegationMap(
    projectConfig,
    projectRaw,
    sessionConfig,
    sessionRaw,
    configPathRef,
  );
  provenance.delegation_map = delegationMapSource;

  const cursorApiKey = resolveRequiredSecret("CURSOR_API_KEY", findings);
  const ghToken = resolveRequiredSecret("GH_TOKEN", findings);
  provenance["secrets.CURSOR_API_KEY"] = cursorApiKey;
  provenance["secrets.GH_TOKEN"] = ghToken;

  const config: OrchestratorConfig = {
    name: String(name.value),
    model: String(model.value),
    prompt: String(prompt.value),
    repositories,
    tasks,
    delegation_map,
    target: {
      auto_create_pr: Boolean(autoPr.value),
      consolidate_prs: Boolean(consolidatePrs.value),
      branch_prefix: String(branchPrefix.value),
      branch_layout: String(branchLayout.value) as BranchLayout,
    },
    bootstrap_repo_name: String(bootstrapRepo.value),
  };

  try {
    validateConfig(config);
  } catch (exc) {
    findings.push(
      finding({
        code: "CFG_SCHEMA_INVALID",
        severity: "error",
        category: "validation",
        message: String(exc),
        field: "config",
        source: "project",
        source_ref: typeof configPathValue.value === "string" ? configPathValue.value : "config",
        expected: "configuration that passes schema and semantic validation",
        actual: "invalid",
        why_it_failed: "Resolved configuration violates one or more required constraints.",
        fix: "Correct the invalid value in config or environment, then rerun `cursor-orch config doctor --strict`.",
        is_blocking: true,
        suggested_commands: ["cursor-orch config doctor --strict"],
        docs_ref: "README#onboarding-clone-to-first-run",
      }),
    );
  }

  return { config, provenance, findings };
}
