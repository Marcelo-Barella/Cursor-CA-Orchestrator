import type { TaskConfig } from "../config/types.js";
import { findClaimOverlaps } from "./claims.js";
import type { GateResult } from "./gates.js";

export type FixPlanBuildResult =
  | { ok: true; tasks: TaskConfig[] }
  | { ok: false; claimCollision: true; tasks: TaskConfig[] };

export function isFixIterationTask(taskId: string): boolean {
  return taskId.startsWith("fix-iter-");
}

type FixEntry = { gate: string; paths: string[]; summary: string; findingsText: string };

function makeFixTask(
  repoAlias: string,
  taskId: string,
  prompt: string,
  allowed_paths: string[],
): TaskConfig {
  return {
    id: taskId,
    repo: repoAlias,
    prompt,
    model: null,
    depends_on: [],
    timeout_minutes: 30,
    create_repo: false,
    repo_config: null,
    allowed_paths,
  };
}

export function buildFixTasks(input: {
  results: GateResult[];
  repoAlias: string;
  iteration: number;
}): FixPlanBuildResult {
  const failed = input.results.filter((r) => !r.passed);
  const withPaths: FixEntry[] = [];
  const withoutPaths: FixEntry[] = [];

  for (const r of failed) {
    const paths = [
      ...new Set(
        r.findings
          .filter((f) => f.severity === "blocking" && f.path)
          .map((f) => f.path!),
      ),
    ];
    const findingsText = r.findings.map((f) => `- [${f.severity}] ${f.message}${f.path ? ` (${f.path})` : ""}`).join("\n");
    const entry: FixEntry = { gate: r.gate, paths, summary: r.summary, findingsText };
    if (paths.length > 0) withPaths.push(entry);
    else withoutPaths.push(entry);
  }

  const tasks: TaskConfig[] = [];
  for (const entry of withPaths) {
    tasks.push(
      makeFixTask(
        input.repoAlias,
        `fix-iter-${input.iteration}-${entry.gate}`,
        `Fix gate ${entry.gate} failures.\nSummary: ${entry.summary}\nFindings:\n${entry.findingsText}`,
        entry.paths,
      ),
    );
  }

  if (withoutPaths.length === 1) {
    const entry = withoutPaths[0]!;
    tasks.push(
      makeFixTask(
        input.repoAlias,
        `fix-iter-${input.iteration}-${entry.gate}`,
        `Fix gate ${entry.gate} failures.\nSummary: ${entry.summary}\nFindings:\n${entry.findingsText}`,
        ["."],
      ),
    );
  } else if (withoutPaths.length > 1) {
    const findingsText = withoutPaths.map((e) => `## ${e.gate}\n${e.findingsText}`).join("\n");
    tasks.push(
      makeFixTask(
        input.repoAlias,
        `fix-iter-${input.iteration}-merged`,
        `Fix multiple gate failures without path claims.\n${findingsText}`,
        ["."],
      ),
    );
  }

  const overlaps = findClaimOverlaps(tasks);
  if (overlaps.length > 0) {
    return { ok: false, claimCollision: true, tasks };
  }
  return { ok: true, tasks };
}
