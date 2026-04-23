import { Command, Flags } from "@oclif/core";
import { RepoStoreClient } from "../api/repo-store.js";
import { parseConfig } from "../config/index.js";
import { formatFailureLogHint, partitionFailedAgents } from "../lib/failure-diagnostics.js";
import { renderLive, renderSnapshot } from "../dashboard.js";
import { deserialize, readEvents } from "../state.js";

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

export default class Status extends Command {
  static summary = "Show orchestration status for a run";

  static flags = {
    run: Flags.string({ required: true, description: "Run ID" }),
    watch: Flags.boolean({ description: "Live dashboard" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Status);
    const opts = { run: flags.run, watch: flags.watch };
    const env = requireEnv(["GH_TOKEN"], {
      code: "STATUS-001",
      severity: "FATAL",
      title: "Missing GH_TOKEN",
      what_happened: "status requires GitHub access.",
      next_step: "Set GH_TOKEN and rerun status.",
      alternative: "Export GH_TOKEN inline.",
      example: "GH_TOKEN=... cursor-orch status --run <run_id>",
      exitCode: 1,
    });
    const repoStore = makeRepoStore(env.GH_TOKEN);
    let content: string;
    try {
      content = await repoStore.readFile(opts.run, "state.json");
    } catch {
      fail({
        code: "STATUS-002",
        severity: "ERROR",
        title: "Run state is unavailable",
        what_happened: "The provided run ID is invalid or inaccessible with current token.",
        next_step: "Verify --run value and token scope.",
        alternative: "Store and reuse the run ID emitted by run output.",
        example: "cursor-orch status --run <saved_run_id>",
        exitCode: 2,
      });
    }
    if (!content) {
      fail({
        code: "STATUS-003",
        severity: "ERROR",
        title: "Missing state.json in run artifact",
        what_happened: "The run branch does not contain orchestration state metadata.",
        next_step: "Confirm this run ID comes from a valid run command.",
        alternative: "Rerun orchestration to regenerate artifacts.",
        example: "cursor-orch run --config ./orchestrator.yaml",
        exitCode: 2,
      });
    }
    const state = deserialize(content);
    const configStr = await repoStore.readFile(opts.run, "config.yaml");
    if (!configStr) {
      fail({
        code: "STATUS-004",
        severity: "ERROR",
        title: "Missing or invalid config snapshot",
        what_happened: "status could not load config.yaml from the run artifact.",
        next_step: "Use a valid run-generated run ID or rerun orchestration.",
        alternative: "Regenerate run artifacts in automation before polling status.",
        example: "cursor-orch run --config ./orchestrator.yaml && cursor-orch status --run <run_id>",
        exitCode: 2,
      });
    }
    let config: ReturnType<typeof parseConfig>;
    try {
      config = parseConfig(configStr);
    } catch {
      fail({
        code: "STATUS-004",
        severity: "ERROR",
        title: "Missing or invalid config snapshot",
        what_happened: "status could not load config.yaml from the run artifact.",
        next_step: "Use a valid run-generated run ID or rerun orchestration.",
        alternative: "Regenerate run artifacts in automation before polling status.",
        example: "cursor-orch run --config ./orchestrator.yaml && cursor-orch status --run <run_id>",
        exitCode: 2,
      });
    }
    if (opts.watch) {
      printNextActions(
        `Keep watching this run: cursor-orch status --run ${opts.run} --watch`,
        `Inspect orchestrator conversation: cursor-orch logs --run ${opts.run}`,
        `Request a stop if needed: cursor-orch stop --run ${opts.run}`,
      );
      await renderLive(repoStore, opts.run, config);
      return;
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
      process.exit(1);
    }
    if (state.status === "completed" || state.status === "running") {
      process.exit(0);
    }
  }
}
