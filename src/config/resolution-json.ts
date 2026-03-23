import { FIELD_PRECEDENCE, FIELD_SOURCE_OF_TRUTH, PRECEDENCE_ORDER } from "./constants.js";
import type { ConfigResolution, DiagnosticFinding } from "./types.js";

export function sourceOfTruthForField(fieldName: string): string {
  return FIELD_SOURCE_OF_TRUTH[fieldName] ?? "resolved value selected by precedence";
}

export function precedenceForField(fieldName: string): string {
  return FIELD_PRECEDENCE[fieldName] ?? "flag > env > project > session > default";
}

function renderSecretValue(fieldName: string, value: unknown, redact: string): unknown {
  if (typeof value !== "string") return value;
  if (redact === "none") return value;
  if (fieldName.startsWith("secrets.")) {
    if (!value) return "missing";
    return "set";
  }
  if (redact === "full") return "<redacted>";
  if (!value) return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function serializeFinding(f: DiagnosticFinding): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    code: f.code,
    severity: f.severity,
    category: f.category,
    message: f.message,
    field: f.field,
    source: f.source,
    source_ref: f.source_ref,
    source_of_truth: sourceOfTruthForField(f.field),
    expected: f.expected,
    actual: f.actual,
    why_it_failed: f.why_it_failed,
    fix: f.fix,
    is_blocking: f.is_blocking,
  };
  if (f.suggested_commands.length) payload.suggested_commands = f.suggested_commands;
  if (f.docs_ref) payload.docs_ref = f.docs_ref;
  if (f.details) payload.details = f.details;
  return payload;
}

function renderProvenanceValue(fieldName: string, value: unknown, redact: string): unknown {
  if (fieldName === "secrets.CURSOR_API_KEY" || fieldName === "secrets.GH_TOKEN") {
    return renderSecretValue(fieldName, value, redact);
  }
  if (fieldName === "prompt") {
    return renderSecretValue(fieldName, value, redact);
  }
  return value;
}

export function resolutionToJson(resolution: ConfigResolution, redact: string): Record<string, unknown> {
  const errors = resolution.findings.filter((f) => f.severity === "error");
  const warnings = resolution.findings.filter((f) => f.severity === "warn");
  const status = errors.length ? "error" : warnings.length ? "warn" : "ok";
  const sourceOfTruth: Record<string, string> = {};
  for (const key of Object.keys(resolution.provenance)) {
    sourceOfTruth[key] = sourceOfTruthForField(key);
  }
  const precedence: Record<string, string> = {};
  for (const key of Object.keys(resolution.provenance)) {
    precedence[key] = precedenceForField(key);
  }
  return {
    status,
    global_precedence: [...PRECEDENCE_ORDER],
    effective_config: {
      name: resolution.config.name,
      model: resolution.config.model,
      prompt: renderSecretValue("prompt", resolution.config.prompt, redact),
      bootstrap_repo_name: resolution.config.bootstrap_repo_name,
      target: {
        auto_create_pr: resolution.config.target.auto_create_pr,
        branch_prefix: resolution.config.target.branch_prefix,
      },
      repositories_count: Object.keys(resolution.config.repositories).length,
      tasks_count: resolution.config.tasks.length,
    },
    provenance: Object.fromEntries(
      Object.entries(resolution.provenance).map(([key, rv]) => [
        key,
        {
          value: renderProvenanceValue(key, rv.value, redact),
          source: rv.source,
          source_ref: rv.source_ref,
          source_of_truth: sourceOfTruthForField(key),
        },
      ]),
    ),
    source_of_truth: sourceOfTruth,
    precedence,
    findings: resolution.findings.map(serializeFinding),
    summary: {
      error: errors.length,
      warn: warnings.length,
      info: resolution.findings.filter((f) => f.severity === "info").length,
    },
  };
}
