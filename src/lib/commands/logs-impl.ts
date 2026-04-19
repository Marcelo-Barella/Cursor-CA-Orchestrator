import { RepoStoreClient } from "../../api/repo-store.js";
import { deserialize, readEvents } from "../../state.js";
import { tui } from "../../tui/style.js";
import type { SDKMessage } from "../../sdk/agent-client.js";

export interface LogsOptions {
  run: string;
  task?: string;
}

type FeedbackOptions = {
  code: string;
  severity: string;
  title: string;
  what_happened: string;
  next_step: string;
  alternative: string;
  example: string;
};

type FailOptions = FeedbackOptions & { exitCode: number };

function printNextActions(...actions: string[]): void {
  if (!actions.length) return;
  console.log("Immediate next actions:");
  for (const action of actions) {
    console.log(`- ${action}`);
  }
}

function renderFeedback(opts: FeedbackOptions): void {
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

function fail(opts: FailOptions): never {
  renderFeedback(opts);
  process.exit(opts.exitCode);
}

function requireEnv(names: string[], opts: FailOptions): Record<string, string> {
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

function getEnv(name: string, failOpts: FailOptions): string {
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
    example: "BOOTSTRAP_OWNER=owner BOOTSTRAP_REPO=repo cursor-orch logs --run <id>",
    exitCode: 1,
  });
  const repo = getEnv("BOOTSTRAP_REPO", {
    code: "ENV-001",
    severity: "FATAL",
    title: "Invalid BOOTSTRAP_REPO",
    what_happened: "Command requires BOOTSTRAP_REPO.",
    next_step: "Set BOOTSTRAP_REPO.",
    alternative: "Export inline.",
    example: "BOOTSTRAP_OWNER=owner BOOTSTRAP_REPO=repo cursor-orch logs --run <id>",
    exitCode: 1,
  });
  return new RepoStoreClient(ghToken, owner, repo);
}

function renderSdkMessage(event: SDKMessage, taskId: string): void {
  switch (event.type) {
    case "assistant": {
      const blocks = event.message.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      console.log(tui.bold(tui.green(`[assistant ${taskId}]`)));
      if (blocks.trim()) console.log(blocks);
      console.log();
      break;
    }
    case "user": {
      const text = event.message.content.map((b) => b.text).join("");
      console.log(tui.bold(tui.cyan(`[user ${taskId}]`)));
      if (text.trim()) console.log(text);
      console.log();
      break;
    }
    case "thinking": {
      console.log(tui.dim(`[thinking ${taskId}] ${event.text.slice(0, 2000)}`));
      break;
    }
    case "tool_call": {
      const args = event.args !== undefined ? JSON.stringify(event.args).slice(0, 400) : "";
      console.log(tui.magenta(`[tool_call ${taskId}] ${event.name} ${event.status}${args ? ` args=${args}` : ""}`));
      break;
    }
    case "status": {
      console.log(tui.yellow(`[status ${taskId}] ${event.status}${event.message ? ` — ${event.message}` : ""}`));
      break;
    }
    case "task": {
      console.log(tui.yellow(`[task ${taskId}] ${event.status ?? ""} ${event.text ?? ""}`.trim()));
      break;
    }
    case "system": {
      console.log(tui.dim(`[system ${taskId}] subtype=${event.subtype ?? ""} model=${event.model ?? ""}`));
      break;
    }
    default:
      break;
  }
}

function parseTranscriptLine(line: string): SDKMessage | null {
  const stripped = line.trim();
  if (!stripped) return null;
  try {
    const parsed = JSON.parse(stripped) as { event?: SDKMessage };
    if (parsed && typeof parsed === "object" && parsed.event) {
      return parsed.event;
    }
  } catch {
    return null;
  }
  return null;
}

export async function runLogsCommand(opts: LogsOptions): Promise<void> {
  const env = requireEnv(["GH_TOKEN"], {
    code: "LOGS-001",
    severity: "FATAL",
    title: "Missing credentials for logs retrieval",
    what_happened: "logs needs GH_TOKEN to read run artifacts.",
    next_step: "Set GH_TOKEN and retry logs.",
    alternative: "Pass env vars inline in scripts.",
    example: "GH_TOKEN=... cursor-orch logs --run <run_id>",
    exitCode: 1,
  });
  const repoStore = makeRepoStore(env.GH_TOKEN);
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
    const transcript = await repoStore.readFile(opts.run, `transcripts/${opts.task}.jsonl`);
    if (!transcript.trim()) {
      renderFeedback({
        code: "LOGS-007",
        severity: "INFO",
        title: "No transcript available yet",
        what_happened: `The worker for task '${opts.task}' has not streamed any events yet (status: ${agent.status}).`,
        next_step: "Wait briefly and request logs again.",
        alternative: "Poll logs with interval in automation.",
        example: "while true; do cursor-orch logs --run <run_id> --task <task_id>; sleep 15; done",
      });
      return;
    }
    for (const line of transcript.split("\n")) {
      const event = parseTranscriptLine(line);
      if (!event) continue;
      renderSdkMessage(event, opts.task);
    }
    printNextActions(`Refresh run state: cursor-orch status --run ${opts.run}`);
    return;
  }

  const events = await readEvents(repoStore, opts.run);
  if (!events.length) {
    renderFeedback({
      code: "LOGS-007",
      severity: "INFO",
      title: "No orchestration events yet",
      what_happened: "The run has not produced any events yet.",
      next_step: "Wait briefly and request logs again.",
      alternative: "Poll logs with interval in automation.",
      example: "while true; do cursor-orch logs --run <run_id>; sleep 15; done",
    });
    return;
  }
  for (const event of events) {
    const ts = event.timestamp;
    const taskLabel = event.task_id ? ` ${event.task_id}` : "";
    const line = `${tui.dim(`[${ts}]`)} ${tui.bold(event.event_type)}${taskLabel} ${event.detail}`;
    console.log(line);
  }
  printNextActions(`Refresh run state: cursor-orch status --run ${opts.run}`);
}
