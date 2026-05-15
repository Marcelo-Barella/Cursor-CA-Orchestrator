import { parseConfig } from "../../config/index.js";
import { renderLive, renderSnapshot } from "../../dashboard.js";
import { formatFailureLogHint, partitionFailedAgents } from "../failure-diagnostics.js";
import { deserialize, readEvents } from "../../state.js";
import { cliRequireEnv, createBootstrapRepoStore } from "./bootstrap-repo-store.js";

type FeedbackOptions = {
  code: string;
  severity: string;
  title: string;
  what_happened: string;
  next_step: string;
  alternative: string;
  example: string;
};

type FailOptions = FeedbackOptions & {
  exitCode: number;
};

export class StatusCommandExit extends Error {
  constructor(readonly exitCode: number) {
    super("status-command-exit");
    this.name = "StatusCommandExit";
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

function printNextActions(...actions: string[]): void {
  if (!actions.length) return;
  console.log("Immediate next actions:");
  for (const action of actions) {
    console.log(`- ${action}`);
  }
}

function finishFatal(opts: FailOptions, finish: (code: number) => never): never {
  renderFeedback(opts);
  return finish(opts.exitCode);
}

export async function runStatusCommand(
  opts: { run: string; watch: boolean },
  deps: { finish: (code: number) => never } = { finish: (c: number): never => process.exit(c) },
): Promise<void> {
  const env = cliRequireEnv(["GH_TOKEN"], {
    code: "STATUS-001",
    severity: "FATAL",
    title: "Missing GH_TOKEN",
    what_happened: "status requires GitHub access.",
    next_step: "Set GH_TOKEN and rerun status.",
    alternative: "Export GH_TOKEN inline.",
    example: "GH_TOKEN=... cursor-orch status --run <run_id>",
    exitCode: 1,
  });
  const repoStore = createBootstrapRepoStore(env.GH_TOKEN);
  let content: string;
  try {
    content = await repoStore.readFile(opts.run, "state.json");
  } catch {
    return finishFatal(
      {
        code: "STATUS-002",
        severity: "ERROR",
        title: "Run state is unavailable",
        what_happened: "The provided run ID is invalid or inaccessible with current token.",
        next_step: "Verify --run value and token scope.",
        alternative: "Store and reuse the run ID emitted by run output.",
        example: "cursor-orch status --run <saved_run_id>",
        exitCode: 2,
      },
      deps.finish,
    );
  }
  if (!content) {
    return finishFatal(
      {
        code: "STATUS-003",
        severity: "ERROR",
        title: "Missing state.json in run artifact",
        what_happened: "The run branch does not contain orchestration state metadata.",
        next_step: "Confirm this run ID comes from a valid run command.",
        alternative: "Rerun orchestration to regenerate artifacts.",
        example: "cursor-orch run --config ./orchestrator.yaml",
        exitCode: 2,
      },
      deps.finish,
    );
  }
  const state = deserialize(content);
  const configStr = await repoStore.readFile(opts.run, "config.yaml");
  if (!configStr) {
    return finishFatal(
      {
        code: "STATUS-004",
        severity: "ERROR",
        title: "Missing or invalid config snapshot",
        what_happened: "status could not load config.yaml from the run artifact.",
        next_step: "Use a valid run-generated run ID or rerun orchestration.",
        alternative: "Regenerate run artifacts in automation before polling status.",
        example: "cursor-orch run --config ./orchestrator.yaml && cursor-orch status --run <run_id>",
        exitCode: 2,
      },
      deps.finish,
    );
  }
  let config: ReturnType<typeof parseConfig>;
  try {
    config = parseConfig(configStr);
  } catch {
    return finishFatal(
      {
        code: "STATUS-004",
        severity: "ERROR",
        title: "Missing or invalid config snapshot",
        what_happened: "status could not load config.yaml from the run artifact.",
        next_step: "Use a valid run-generated run ID or rerun orchestration.",
        alternative: "Regenerate run artifacts in automation before polling status.",
        example: "cursor-orch run --config ./orchestrator.yaml && cursor-orch status --run <run_id>",
        exitCode: 2,
      },
      deps.finish,
    );
  }
  if (opts.watch) {
    printNextActions(
      `Keep watching this run: cursor-orch status --run ${opts.run} --watch`,
      `Inspect orchestrator conversation: cursor-orch logs --run ${opts.run}`,
      `Request a stop if needed: cursor-orch stop --run ${opts.run}`,
    );
    await renderLive(repoStore, opts.run, config);
    return deps.finish(0);
  }
  const events = await readEvents(repoStore, opts.run);
  await renderSnapshot(state, config, events);
  printNextActions(
    `Watch live updates: cursor-orch status --run ${opts.run} --watch`,
    `Inspect logs: cursor-orch logs --run ${opts.run}`,
  );
  if (state.status === "running") {
    printNextActions(`Request stop when needed: cursor-orch stop --run ${opts.run}`);
  }
  if (state.status === "failed") {
    const { roots } = partitionFailedAgents(state.agents);
    if (roots.length) {
      printNextActions(
        ...roots.map((r) => `Inspect root transcript: ${formatFailureLogHint(opts.run, r.taskId)}`),
      );
    }
    printNextActions(
      "Re-run with validated configuration: cursor-orch run --config ./orchestrator.yaml",
      `Fetch conversation details: cursor-orch logs --run ${opts.run}`,
    );
    return deps.finish(1);
  }
  if (state.status === "completed" || state.status === "running") {
    return deps.finish(0);
  }
}
