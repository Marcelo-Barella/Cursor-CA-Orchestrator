import type { TaskConfig } from "../config/types.js";
import { findClaimOverlaps } from "./claims.js";
import type { GateResult } from "./gates.js";

export type FixPlanBuildResult =
  | { ok: true; tasks: TaskConfig[] }
  | { ok: false; claimCollision: true; tasks: TaskConfig[] };

export function buildFixPlanDocument(tasks: TaskConfig[]): { tasks: TaskConfig[] } {
  return { tasks };
}

export function buildFixTasks(input: {
  results: GateResult[];
  repoAlias: string;
  iteration: number;
}): FixPlanBuildResult {
  const failed = input.results.filter((r) => !r.passed);
  const withPaths: { gate: string; repoAlias?: string; paths: string[]; summary: string; findingsText: string }[] = [];
  const withoutPaths: typeof withPaths = [];

  for (const r of failed) {
    const paths = [
      ...new Set(
        r.findings
          .filter((f) => f.severity === "blocking" && f.path)
          .map((f) => f.path!),
      ),
    ];
    const findingsText = r.findings.map((f) => `- [${f.severity}] ${f.message}${f.path ? ` (${f.path})` : ""}`).join("\n");
    const entry = { gate: r.gate, repoAlias: r.repoAlias, paths, summary: r.summary, findingsText };
    if (paths.length > 0) withPaths.push(entry);
    else withoutPaths.push(entry);
  }

  const tasks: TaskConfig[] = [];
  for (const entry of withPaths) {
    tasks.push({
      id: `fix-iter-${input.iteration}-${entry.gate}`,
      repo: entry.repoAlias ?? input.repoAlias,
      prompt: `Fix gate ${entry.gate} failures.\nSummary: ${entry.summary}\nFindings:\n${entry.findingsText}`,
      model: null,
      depends_on: [],
      timeout_minutes: 30,
      create_repo: false,
      repo_config: null,
      allowed_paths: entry.paths,
    });
  }

  if (withoutPaths.length === 1) {
    const entry = withoutPaths[0]!;
    tasks.push({
      id: `fix-iter-${input.iteration}-${entry.gate}`,
      repo: entry.repoAlias ?? input.repoAlias,
      prompt: `Fix gate ${entry.gate} failures.\nSummary: ${entry.summary}\nFindings:\n${entry.findingsText}`,
      model: null,
      depends_on: [],
      timeout_minutes: 30,
      create_repo: false,
      repo_config: null,
      allowed_paths: ["."],
    });
  } else if (withoutPaths.length > 1) {
    const findingsText = withoutPaths.map((e) => `## ${e.gate}\n${e.findingsText}`).join("\n");
    const mergedRepo = withoutPaths.every((e) => (e.repoAlias ?? input.repoAlias) === (withoutPaths[0]!.repoAlias ?? input.repoAlias))
      ? (withoutPaths[0]!.repoAlias ?? input.repoAlias)
      : input.repoAlias;
    tasks.push({
      id: `fix-iter-${input.iteration}-merged`,
      repo: mergedRepo,
      prompt: `Fix multiple gate failures without path claims.\n${findingsText}`,
      model: null,
      depends_on: [],
      timeout_minutes: 30,
      create_repo: false,
      repo_config: null,
      allowed_paths: ["."],
    });
  }

  const overlaps = findClaimOverlaps(tasks);
  if (overlaps.length > 0) {
    return { ok: false, claimCollision: true, tasks };
  }
  return { ok: true, tasks };
}
