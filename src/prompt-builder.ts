import type { TaskConfig } from "./config/types.js";
import { WORKER_SYSTEM_PROMPT } from "./system-prompt.js";

const MAX_DEP_OUTPUT_BYTES = 50 * 1024;

export type WorkerPromptOpts = {
  runBranch?: string;
  launchRef?: string;
  perTaskBranch?: string;
};

function buildWorkerPayloadPath(runId: string, taskId: string): string {
  return `/tmp/cursor-orch-${runId}-${taskId}-payload.json`;
}

export function buildWorkerPrompt(
  task: TaskConfig,
  runId: string,
  dependencyOutputs: Record<string, Record<string, unknown>>,
  bootstrapOwner = "",
  bootstrapRepo = "",
  opts?: WorkerPromptOpts,
): string {
  const sections = [
    WORKER_SYSTEM_PROMPT,
    sectionTask(task),
    sectionDependencies(task, dependencyOutputs),
    opts?.runBranch ? sectionGitRunLine(opts.runBranch, opts.launchRef, opts.perTaskBranch) : "",
    sectionOutputProtocol(task, runId, bootstrapOwner, bootstrapRepo),
    sectionRules(opts?.runBranch),
  ];
  return sections.filter(Boolean).join("\n\n");
}

export function buildRepoCreationPrompt(
  task: TaskConfig,
  runId: string,
  dependencyOutputs: Record<string, Record<string, unknown>>,
  bootstrapOwner = "",
  bootstrapRepo = "",
): string {
  const sections = [
    WORKER_SYSTEM_PROMPT,
    sectionTask(task),
    sectionRepoCreation(task),
    sectionDependencies(task, dependencyOutputs),
    sectionOutputProtocol(task, runId, bootstrapOwner, bootstrapRepo),
    sectionRules(),
  ];
  return sections.filter(Boolean).join("\n\n");
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
    "or files into this repository. To create the new repo and populate it with code:\n",
    "  1. Create the repo: `gh repo create <owner>/<repo> --private` (or use --public/--description as needed)\n",
    "  2. Clone it: `gh repo clone <owner>/<repo> /tmp/<repo>` (or `git clone https://github.com/<owner>/<repo>.git /tmp/<repo>`; GitHub auth is preconfigured in this environment)\n",
    "  3. Write code in the cloned directory, commit, and push.\n",
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

function sectionOutputProtocol(
  task: TaskConfig,
  runId: string,
  bootstrapOwner: string,
  bootstrapRepo: string,
): string {
  const payloadPath = buildWorkerPayloadPath(runId, task.id);
  return `WHEN YOU ARE DONE:
Run the following commands in the shell to report your results.
Replace the placeholder values with your actual output.
The \`gh\` CLI uses GitHub credentials already configured for this agent; do not paste or export tokens in the shell.

\`\`\`bash
node <<'NJS'
const fs = require("fs");
const output = {
  task_id: "${task.id}",
  status: "completed",
  summary: "DESCRIBE WHAT YOU DID HERE",
  blocked_reason: null,
  outputs: { key: "PUT ARTIFACTS OTHER TASKS MAY NEED HERE" },
};
const content = Buffer.from(JSON.stringify(output, null, 2)).toString("base64");
fs.writeFileSync(
  "${payloadPath}",
  JSON.stringify({ message: "agent output", content, branch: "run/${runId}" }),
);
NJS

gh api --method PUT \\
  /repos/${bootstrapOwner}/${bootstrapRepo}/contents/agent-${task.id}.json \\
  --input ${payloadPath}
\`\`\`

Edit the \`output\` dict before running:
- Set "summary" to a concise description of what you did.
- Set "outputs" to a dict of artifacts downstream tasks may need (interfaces, schemas, file paths). If none needed, use an empty dict.
- If you are blocked, set "status" to "blocked" and "blocked_reason" to a specific explanation.`;
}

function sectionRules(runLineBranch?: string): string {
  if (runLineBranch) {
    return `RULES:
- Focus only on your assigned task. Do not modify unrelated code.
- If you are blocked, report it using the output script with status "blocked" and a specific blocked_reason.
- Do not attempt to communicate with other agents. Only write to your designated output file on the bootstrap repo (per the protocol above).
- Do not create a pull request yourself.
# MANDATORY: Commit and push your changes to branch "${runLineBranch}" on the task repository before reporting completion`;
  }
  return `RULES:
- Focus only on your assigned task. Do not modify unrelated code.
- If you are blocked, report it using the output script with status "blocked" and a specific blocked_reason.
- Do not attempt to communicate with other agents. Only write to your designated run branch file.
- Create a clean, focused PR with a descriptive title and body.
- Do not read or write any run branch files other than your designated output file.
# MANDATORY: At the end of your task, commit and push your changes directly to the repository`;
}
