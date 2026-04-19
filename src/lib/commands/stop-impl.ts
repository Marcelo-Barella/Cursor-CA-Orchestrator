import { RepoStoreClient } from "../../api/repo-store.js";
import { deserialize } from "../../state.js";

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

export interface StopOptions {
  run: string;
}

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

export async function runStopCommand(opts: StopOptions): Promise<void> {
  const env = requireEnv(["GH_TOKEN"], {
    code: "STOP-001",
    severity: "FATAL",
    title: "Missing credentials for stop operation",
    what_happened: "stop requires GH_TOKEN to write the stop sentinel to the bootstrap repo.",
    next_step: "Set GH_TOKEN and retry stop.",
    alternative: "Provide env vars inline for one-shot stop.",
    example: "GH_TOKEN=... cursor-orch stop --run <run_id>",
    exitCode: 1,
  });
  const repoStore = makeRepoStore(env.GH_TOKEN);
  const content = await repoStore.readFile(opts.run, "state.json");
  if (!content) {
    fail({
      code: "STOP-002",
      severity: "ERROR",
      title: "Cannot resolve run state for stop",
      what_happened: "state.json was not found in the provided run.",
      next_step: "Confirm the run ID belongs to a valid orchestration run.",
      alternative: "Save run ID from run output and pass it directly.",
      example: "cursor-orch stop --run <saved_run_id>",
      exitCode: 1,
    });
  }

  deserialize(content);
  const stopPayload = JSON.stringify({
    requested_at: new Date().toISOString(),
    requested_by: "cli",
  });

  console.log("Writing stop request to run branch...");
  await repoStore.writeFile(opts.run, "stop-requested.json", stopPayload);

  renderFeedback({
    code: "STOP-003",
    severity: "INFO",
    title: "Stop sentinel written",
    what_happened: "stop-requested.json was written to the run branch; the Cursor SDK does not support cloud agent cancellation, so the orchestrator will dispose workers and halt on its next loop iteration.",
    next_step: "Monitor run status until it reports 'stopped'.",
    alternative: "Poll status in a script until state changes.",
    example: "cursor-orch status --run <run_id> --watch",
  });

  console.log("Stop requested. The orchestrator will halt on its next loop iteration.");
  printNextActions(
    `Confirm stop completion: cursor-orch status --run ${opts.run} --watch`,
    `Inspect latest orchestrator logs: cursor-orch logs --run ${opts.run}`,
  );
}
