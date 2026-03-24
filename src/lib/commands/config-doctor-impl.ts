import {
  precedenceForField,
  resolveConfigPrecedence,
  resolutionToJson,
  sourceOfTruthForField,
  type ConfigResolution,
  type DiagnosticFinding,
} from "../../config/index.js";
import { severityStyle } from "../../tui/style.js";

function printFindings(findings: DiagnosticFinding[]): void {
  for (const finding of findings) {
    const level = finding.severity.toUpperCase();
    const sev =
      finding.severity === "error" ? "error" : finding.severity === "warn" ? "warn" : "info";
    const style = severityStyle(sev);
    console.log(style(`${level} ${finding.code}`), finding.message);
    console.log(`Field: ${finding.field}`);
    console.log(`Source of truth: ${sourceOfTruthForField(finding.field)}`);
    console.log(`Precedence: ${precedenceForField(finding.field)}`);
    console.log(`Source: ${finding.source} (${finding.source_ref})`);
    console.log(`Why: ${finding.why_it_failed}`);
    console.log(`Recovery: ${finding.fix}`);
    if (finding.suggested_commands.length) {
      console.log("Commands:");
      for (const command of finding.suggested_commands) {
        console.log(`  - ${command}`);
      }
    }
    console.log();
  }
}

function displayValue(fieldName: string, value: unknown): string {
  if (fieldName === "prompt") {
    if (typeof value !== "string" || value === "") {
      return "<empty>";
    }
    if (value.length <= 40) {
      return value;
    }
    return `${value.slice(0, 37)}...`;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (value === null || value === undefined) {
    return "<unset>";
  }
  return String(value);
}

function printResolutionSummary(resolution: ConfigResolution): void {
  const keys = [
    "config_path",
    "name",
    "model",
    "prompt",
    "bootstrap_repo_name",
    "target.auto_create_pr",
    "target.branch_prefix",
    "repositories",
    "tasks",
    "secrets.CURSOR_API_KEY",
    "secrets.GH_TOKEN",
  ];
  console.log("Resolution Summary:");
  for (const key of keys) {
    const resolved = resolution.provenance[key];
    if (!resolved) continue;
    let rendered = displayValue(key, resolved.value);
    if (key.startsWith("secrets.")) {
      rendered = typeof resolved.value === "string" && resolved.value ? "set" : "missing";
    }
    console.log(
      `  - ${key}: ${rendered} [effective=${resolved.source} -> ${resolved.source_ref}; source-of-truth=${sourceOfTruthForField(key)}; precedence=${precedenceForField(key)}]`,
    );
  }
}

export function runConfigDoctorCommand(opts: {
  config?: string;
  json?: boolean;
  strict?: boolean;
  redact: string;
}): number {
  const resolution = resolveConfigPrecedence(opts.config, undefined);
  if (opts.json) {
    console.log(JSON.stringify(resolutionToJson(resolution, opts.redact), null, 2));
  } else {
    printResolutionSummary(resolution);
    if (resolution.findings.length) {
      console.log();
      console.log("Findings:");
      printFindings(resolution.findings);
    }
  }
  const errors = resolution.findings.filter((finding) => finding.severity === "error");
  const warnings = resolution.findings.filter((finding) => finding.severity === "warn");
  if (errors.length) {
    return 1;
  }
  if (opts.strict && warnings.length) {
    return 2;
  }
  return 0;
}
