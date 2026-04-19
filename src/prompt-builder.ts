import type { TaskConfig } from "./config/types.js";
import { WORKER_SYSTEM_PROMPT } from "./system-prompt.js";

const MAX_DEP_OUTPUT_BYTES = 50 * 1024;

export const WORKER_OUTPUT_ARTIFACT_PATH = "cursor-orch-output.json";

export type WorkerPromptOpts = {
  runBranch?: string;
  launchRef?: string;
  perTaskBranch?: string;
};

export function buildWorkerPrompt(
  task: TaskConfig,
  runId: string,
  dependencyOutputs: Record<string, Record<string, unknown>>,
  opts?: WorkerPromptOpts,
): string {
  const sections = [
    WORKER_SYSTEM_PROMPT,
    sectionRunContext(runId),
    sectionTask(task),
    sectionDependencies(task, dependencyOutputs),
    opts?.runBranch ? sectionGitRunLine(opts.runBranch, opts.launchRef, opts.perTaskBranch) : "",
    sectionOutputProtocol(task),
    sectionRules(opts?.runBranch),
  ];
  return sections.filter(Boolean).join("\n\n");
}

export function buildRepoCreationPrompt(
  task: TaskConfig,
  runId: string,
  dependencyOutputs: Record<string, Record<string, unknown>>,
): string {
  const sections = [
    WORKER_SYSTEM_PROMPT,
    sectionRunContext(runId),
    sectionTask(task),
    sectionRepoCreation(task),
    sectionDependencies(task, dependencyOutputs),
    sectionOutputProtocol(task),
    sectionRules(),
  ];
  return sections.filter(Boolean).join("\n\n");
}

function sectionRunContext(runId: string): string {
  return `ORCHESTRATION RUN: ${runId}`;
}

function sectionRepoCreation(task: TaskConfig): string {
  const lines = ["REPO CREATION TASK:", "You must create a new GitHub repository as part of this task."];
  if (task.repo_config) {
    lines.push(`Repository configuration: ${JSON.stringify(task.repo_config)}`);
  }
  lines.push(
    "",
    'IMPORTANT: After creating the repo, include "repo_url" in your output\'s "outputs" dict,',
    "set to the full HTTPS URL of the newly created repository (e.g. https://github.com/owner/repo-name).",
    "Downstream tasks depend on this value to locate the repository.",
    "",
    "CRITICAL: You are running in a read-only bootstrap repository. Do NOT write any code ",
    "or files into this repository. To create the new repo and populate it with code:",
    "  1. Create the repo: `gh repo create <owner>/<repo> --private` (or use --public/--description as needed)",
    "  2. Clone it: `gh repo clone <owner>/<repo> /tmp/<repo>` (or `git clone https://github.com/<owner>/<repo>.git /tmp/<repo>`; GitHub auth is preconfigured in this environment)",
    "  3. Write code in the cloned directory, commit, and push.",
    "All code MUST go to the new repo, not to the current working directory.",
  );
  return lines.join("\n");
}

function sectionTask(task: TaskConfig): string {
  return `You are working on task "${task.id}" as part of an orchestrated multi-repo workflow.\n\nYOUR TASK:\n${task.prompt.trim()}`;
}

function sectionGitRunLine(runBranch: string, launchRef?: string, perTaskBranch?: string): string {
  const refLine =
    launchRef !== undefined && launchRef !== ""
      ? `Your workspace was created from ref "${launchRef}"; accumulated work for this orchestration run lives on branch "${runBranch}".`
      : `Accumulated work for this orchestration run lives on branch "${runBranch}".`;
  const retryNote = perTaskBranch
    ? `If you must use a differently named branch (e.g. retry), still merge or cherry-pick into "${runBranch}" and push "${runBranch}" so the next task sees your commits.`
    : "";
  return [
    "GIT TARGET (run-line workflow):",
    refLine,
    `Commit and push all code changes to branch "${runBranch}" only (e.g. push to origin ${runBranch}).`,
    "Do not open a pull request; the orchestrator opens one PR from this branch when all tasks complete.",
    retryNote,
  ]
    .filter(Boolean)
    .join("\n");
}

function sectionDependencies(task: TaskConfig, dependencyOutputs: Record<string, Record<string, unknown>>): string {
  if (!task.depends_on.length) {
    return "";
  }
  const lines = [
    "CONTEXT FROM UPSTREAM TASKS:",
    "The following outputs were produced by tasks that completed before yours.",
    "Use this information as needed to complete your task.",
  ];
  for (const depId of task.depends_on) {
    let depData = dependencyOutputs[depId] ?? {};
    let serialized = JSON.stringify(depData, null, 2);
    if (Buffer.byteLength(serialized, "utf8") > MAX_DEP_OUTPUT_BYTES) {
      depData = {
        _truncated: true,
        summary: String((depData as { summary?: string }).summary ?? "").slice(0, 4096),
        note: `Full output available in agent-${depId}.json on the run branch.`,
      };
      serialized = JSON.stringify(depData, null, 2);
    }
    lines.push(`\n--- Output from task "${depId}" ---`, serialized, `--- End output from "${depId}" ---`);
  }
  return lines.join("\n");
}

function sectionOutputProtocol(task: TaskConfig): string {
  return `WHEN YOU ARE DONE (REPORTING PROTOCOL):
The orchestrator collects your results through two channels. Produce BOTH.

CHANNEL 1 (primary) — workspace artifact:
Write the following JSON to a file named \`${WORKER_OUTPUT_ARTIFACT_PATH}\` at the repository workspace root.
Do NOT stage, commit, or push this file. Leave it uncommitted so the orchestrator can read it as a workspace artifact.

CHANNEL 2 (backup) — final assistant message:
Include the same JSON as a fenced \`\`\`json\`\`\` block at the end of your last assistant message. If the artifact is unavailable, the orchestrator will parse this block instead.

JSON schema (identical on both channels):

\`\`\`json
{
  "task_id": "${task.id}",
  "status": "completed" | "blocked" | "failed",
  "summary": "DESCRIBE WHAT YOU DID HERE",
  "blocked_reason": null,
  "outputs": { "key": "PUT ARTIFACTS OTHER TASKS MAY NEED HERE" }
}
\`\`\`

Edit the JSON before reporting:
- Set "summary" to a concise description of what you did.
- Set "outputs" to a dict of artifacts downstream tasks may need (interfaces, schemas, file paths). If none needed, use an empty dict.
- If you are blocked, set "status" to "blocked" and "blocked_reason" to a specific explanation.`;
}

function sectionRules(runLineBranch?: string): string {
  if (runLineBranch) {
    return `RULES:
- Focus only on your assigned task. Do not modify unrelated code.
- If you are blocked, report it using the output JSON (both channels) with status "blocked" and a specific blocked_reason.
- Do not attempt to communicate with other agents. Report only via the artifact + final assistant JSON block described above.
- Do not create a pull request yourself.
# MANDATORY: Commit and push your code changes to branch "${runLineBranch}" on the task repository before reporting completion. Do NOT push \`${WORKER_OUTPUT_ARTIFACT_PATH}\`.`;
  }
  return `RULES:
- Focus only on your assigned task. Do not modify unrelated code.
- If you are blocked, report it using the output JSON (both channels) with status "blocked" and a specific blocked_reason.
- Do not attempt to communicate with other agents. Report only via the artifact + final assistant JSON block described above.
- Create a clean, focused PR with a descriptive title and body.
# MANDATORY: At the end of your task, commit and push your code changes directly to the repository. Do NOT push \`${WORKER_OUTPUT_ARTIFACT_PATH}\`.`;
}
