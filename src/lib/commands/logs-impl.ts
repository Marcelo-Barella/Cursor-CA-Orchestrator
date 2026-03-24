import { CursorClient, type Message } from "../../api/cursor-client.js";
import { RepoStoreClient } from "../../api/repo-store.js";
import { deserialize } from "../../state.js";
import { tui } from "../../tui/style.js";

export interface LogsOptions {
  run: string;
  task?: string;
}

function printNextActions(...actions: string[]): void {
  if (!actions.length) return;
  console.log("Immediate next actions:");
  for (const action of actions) {
    console.log(`- ${action}`);
  }
}

function renderFeedback(opts: {
  code: string;
  severity: string;
  title: string;
  what_happened: string;
  next_step: string;
  alternative: string;
  example: string;
}): void {
  console.log(
    [
      `[${opts.severity}] ${opts.code} ${opts.title}`,
      `What happened: ${opts.what_happened}`,
      `Next step: ${opts.next_step}`,
      `Non-interactive alternative: ${opts.alternative}`,
      `Example: ${opts.example}`,
    ].join("\n"),
  );
}

function fail(opts: {
  code: string;
  severity: string;
  title: string;
  what_happened: string;
  next_step: string;
  alternative: string;
  example: string;
  exitCode: number;
}): never {
  renderFeedback(opts);
  process.exit(opts.exitCode);
}

function requireEnv(names: string[], opts: Parameters<typeof fail>[0]): Record<string, string> {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || !raw.trim()) {
      missing.push(name);
    } else {
      values[name] = raw.trim();
    }
  }
  if (missing.length) {
    fail({
      ...opts,
      what_happened: `${opts.what_happened} Missing or empty: ${missing.join(", ")}.`,
    });
  }
  return values;
}

function getEnv(
  name: string,
  failOpts: {
    code: string;
    severity: string;
    title: string;
    what_happened: string;
    next_step: string;
    alternative: string;
    example: string;
    exitCode: number;
  },
): string {
  const value = process.env[name];
  if (value === undefined || !value.trim()) {
    const actual = value === undefined ? "missing" : "empty";
    fail({
      ...failOpts,
      what_happened: `${failOpts.what_happened} ${name} is ${actual}.`,
    });
  }
  return value.trim();
}

function makeRepoStore(ghToken: string): RepoStoreClient {
  const owner = getEnv("BOOTSTRAP_OWNER", {
    code: "ENV-001",
    severity: "FATAL",
    title: "Invalid BOOTSTRAP_OWNER",
    what_happened: "Command requires BOOTSTRAP_OWNER.",
    next_step: "Set BOOTSTRAP_OWNER.",
    alternative: "Export inline.",
    example: "BOOTSTRAP_OWNER=owner BOOTSTRAP_REPO=repo cursor-orch status --run <id>",
    exitCode: 1,
  });
  const repo = getEnv("BOOTSTRAP_REPO", {
    code: "ENV-001",
    severity: "FATAL",
    title: "Invalid BOOTSTRAP_REPO",
    what_happened: "Command requires BOOTSTRAP_REPO.",
    next_step: "Set BOOTSTRAP_REPO.",
    alternative: "Export inline.",
    example: "BOOTSTRAP_OWNER=owner BOOTSTRAP_REPO=repo cursor-orch status --run <id>",
    exitCode: 1,
  });
  return new RepoStoreClient(ghToken, owner, repo);
}

function renderMessage(message: Message): void {
  const label =
    message.role === "user"
      ? tui.bold(tui.cyan(`[${message.role}]`))
      : tui.bold(tui.green(`[${message.role}]`));
  console.log(label, message.text);
  console.log();
}

export async function runLogsCommand(opts: LogsOptions): Promise<void> {
  const env = requireEnv(["CURSOR_API_KEY", "GH_TOKEN"], {
    code: "LOGS-001",
    severity: "FATAL",
    title: "Missing credentials for logs retrieval",
    what_happened: "logs needs GH_TOKEN for state and CURSOR_API_KEY for conversation fetch.",
    next_step: "Set required variables and retry logs.",
    alternative: "Pass env vars inline in scripts.",
    example: "CURSOR_API_KEY=... GH_TOKEN=... cursor-orch logs --run <run_id>",
    exitCode: 1,
  });
  const repoStore = makeRepoStore(env.GH_TOKEN);
  const cursorClient = new CursorClient(env.CURSOR_API_KEY);
  const content = await repoStore.readFile(opts.run, "state.json");
  if (!content) {
    fail({
      code: "LOGS-002",
      severity: "ERROR",
      title: "Cannot load run state for logs",
      what_happened: "state.json was not found in the provided run.",
      next_step: "Verify the run ID from run output.",
      alternative: "Persist run IDs in automation metadata.",
      example: "cursor-orch logs --run <saved_run_id>",
      exitCode: 1,
    });
  }

  const state = deserialize(content);
  let targetAgentId: string | null = null;

  if (opts.task) {
    const agent = state.agents[opts.task];
    if (!agent) {
      fail({
        code: "LOGS-003",
        severity: "ERROR",
        title: "Task not found in orchestration state",
        what_happened: "The supplied --task value does not match any task id in this run.",
        next_step: "Inspect status output to identify valid task ids.",
        alternative: "Parse task ids from state.json before calling logs.",
        example: "cursor-orch logs --run <run_id> --task <valid_task_id>",
        exitCode: 1,
      });
    }

    if (!agent.agent_id) {
      renderFeedback({
        code: "LOGS-004",
        severity: "WARN",
        title: "Task has no agent conversation yet",
        what_happened: `The task exists but no agent id has been assigned (status: ${agent.status}).`,
        next_step: "Wait for scheduling and check status again.",
        alternative: "Poll status before requesting task logs.",
        example: "cursor-orch status --run <run_id> --watch",
      });
      return;
    }

    targetAgentId = agent.agent_id;
  } else {
    if (!state.orchestrator_agent_id) {
      renderFeedback({
        code: "LOGS-005",
        severity: "WARN",
        title: "No orchestrator agent id recorded",
        what_happened: "The run state does not contain an orchestrator conversation target.",
        next_step: "Check if run initialization completed successfully.",
        alternative: "Rerun orchestration with valid credentials and config.",
        example: "cursor-orch run --config ./orchestrator.yaml",
      });
      return;
    }

    targetAgentId = state.orchestrator_agent_id;
  }

  let messages: Message[];
  try {
    messages = await cursorClient.getConversation(targetAgentId);
  } catch (error) {
    fail({
      code: "LOGS-006",
      severity: "ERROR",
      title: "Failed to fetch conversation logs",
      what_happened: `The conversation API request failed for the target agent: ${String(error)}.`,
      next_step: "Verify CURSOR_API_KEY and agent id validity, then retry.",
      alternative: "Retry with backoff in scripts.",
      example: "cursor-orch logs --run <run_id> --task <task_id>",
      exitCode: 1,
    });
  }

  if (!messages.length) {
    renderFeedback({
      code: "LOGS-007",
      severity: "INFO",
      title: "No messages available yet",
      what_happened: "The target conversation exists but has no messages.",
      next_step: "Wait briefly and request logs again.",
      alternative: "Poll logs with interval in automation.",
      example: "while true; do cursor-orch logs --run <run_id>; sleep 15; done",
    });
    return;
  }

  for (const message of messages) {
    renderMessage(message);
  }

  printNextActions(`Refresh run state: cursor-orch status --run ${opts.run}`);
}
