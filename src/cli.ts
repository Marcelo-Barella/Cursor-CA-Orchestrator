#!/usr/bin/env node
import chalk from "chalk";
import { Command } from "commander";
import { CursorClient } from "./api/cursor-client.js";
import { RepoStoreClient } from "./api/repo-store.js";
import { ensureBootstrapRepo, BOOTSTRAP_ENTRYPOINT, BOOTSTRAP_INSTALL_COMMAND } from "./bootstrap.js";
import {
  parseConfig,
  resolveConfigPrecedence,
  toYaml,
  precedenceForField,
  sourceOfTruthForField,
  resolutionToJson,
  type ConfigResolution,
  type DiagnosticFinding,
} from "./config/index.js";
import { deserialize, readEvents, serialize, createInitialState, seedMainAgent, syncToRepo } from "./state.js";
import { loadEnvFile } from "./env.js";
import { runRepl } from "./repl.js";
import { renderLive, renderSnapshot } from "./dashboard.js";
import { randomUUID } from "node:crypto";

function printNextActions(...actions: string[]): void {
  if (!actions.length) return;
  console.log("Immediate next actions:");
  for (const a of actions) {
    console.log(`- ${a}`);
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

function printFindings(findings: DiagnosticFinding[]): void {
  for (const finding of findings) {
    const level = finding.severity.toUpperCase();
    const style =
      finding.severity === "error" ? chalk.red : finding.severity === "warn" ? chalk.yellow : chalk.cyan;
    console.log(style(`${level} ${finding.code}`), finding.message);
    console.log(`Field: ${finding.field}`);
    console.log(`Source of truth: ${sourceOfTruthForField(finding.field)}`);
    console.log(`Precedence: ${precedenceForField(finding.field)}`);
    console.log(`Source: ${finding.source} (${finding.source_ref})`);
    console.log(`Why: ${finding.why_it_failed}`);
    console.log(`Recovery: ${finding.fix}`);
    if (finding.suggested_commands.length) {
      console.log("Commands:");
      for (const c of finding.suggested_commands) {
        console.log(`  - ${c}`);
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

function resolveConfig(configPath: string | undefined, bootstrapRepo: string | undefined): ConfigResolution {
  const resolution = resolveConfigPrecedence(configPath, bootstrapRepo);
  const blocking = resolution.findings.filter((f) => f.is_blocking);
  if (blocking.length) {
    printFindings(blocking);
    fail({
      code: "RUN-003",
      severity: "FATAL",
      title: "Configuration resolution failed",
      what_happened: "Required values are missing or invalid after applying precedence.",
      next_step: "Apply the suggested fixes and rerun config doctor.",
      alternative: "Pin intended values with flags or environment variables in automation.",
      example: "cursor-orch config doctor --strict",
      exitCode: 1,
    });
  }
  return resolution;
}

function printNonBlockingFindings(findings: DiagnosticFinding[]): void {
  const nb = findings.filter((f) => !f.is_blocking);
  if (!nb.length) return;
  console.log();
  console.log("Diagnostics:");
  printFindings(nb);
}

function resolveBootstrapName(cliName: string | undefined, config: { bootstrap_repo_name: string } | null): string {
  if (cliName) return cliName;
  if (config?.bootstrap_repo_name) return config.bootstrap_repo_name;
  return "cursor-orch-bootstrap";
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

function getEnv(
  name: string,
  failOpts: { code: string; severity: string; title: string; what_happened: string; next_step: string; alternative: string; example: string; exitCode: number },
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

function buildOrchestrationLaunchPrompt(opts: {
  runId: string;
  ghToken: string;
  cursorApiKey: string;
  runtimeRef: string;
  bootstrapOwner: string;
  bootstrapRepoName: string;
}): string {
  return [
    "You are the main agent on a cursor-orch orchestrator workflow.",
    "Run the following shell commands exactly as written.",
    `export RUN_ID='${opts.runId}'`,
    `export GH_TOKEN='${opts.ghToken}'`,
    `export CURSOR_API_KEY='${opts.cursorApiKey}'`,
    `export CURSOR_ORCH_RUNTIME_REF='${opts.runtimeRef}'`,
    `export BOOTSTRAP_OWNER='${opts.bootstrapOwner}'`,
    `export BOOTSTRAP_REPO='${opts.bootstrapRepoName}'`,
    BOOTSTRAP_INSTALL_COMMAND,
    BOOTSTRAP_ENTRYPOINT,
    "If the install command fails, stop and report the exact error output.",
    "If the orchestrator command fails, report the full stderr output.",
    'If the orchestrator command succeeds, report "Bootstrap complete" followed by the last 50 lines of stdout.',
    "Do not modify repository files.",
  ].join("\n");
}

async function runOrchestrationCli(
  config: import("./config/types.js").OrchestratorConfig,
  configYaml: string,
  cursorApiKey: string,
  ghToken: string,
  bootstrapRepo: string | undefined,
): Promise<void> {
  const repoName = resolveBootstrapName(bootstrapRepo, config);
  const repoInfo = await ensureBootstrapRepo(ghToken, repoName);
  const runtimeRef = repoInfo.runtime_ref;
  const owner = repoInfo.owner;
  console.log(`Bootstrap repo verified: ${owner}/${repoInfo.name} @ ${runtimeRef}`);

  const repoStore = new RepoStoreClient(ghToken, owner, repoInfo.name);

  const orchestrationId = randomUUID().slice(0, 8);

  await repoStore.createRun(orchestrationId);

  const initialState = createInitialState(config, orchestrationId);

  await repoStore.writeFile(orchestrationId, "config.yaml", configYaml);
  await repoStore.writeFile(orchestrationId, "state.json", serialize(initialState));
  await repoStore.writeFile(orchestrationId, "summary.md", `# ${config.name}\n\nOrchestration pending...\n`);

  console.log(`Created run branch: run/${orchestrationId}`);
  console.log(`Run ID: ${orchestrationId}`);
  printNextActions(
    `Watch run status: cursor-orch status --run ${orchestrationId}`,
    `Inspect orchestrator logs: cursor-orch logs --run ${orchestrationId}`,
    `Request stop when needed: cursor-orch stop --run ${orchestrationId}`,
  );

  const cursorClient = new CursorClient(cursorApiKey);
  const repoUrl = `https://github.com/${owner}/${repoInfo.name}`;

  console.log(`Launching orchestrator agent against ${owner}/${repoInfo.name}...`);
  const launchPrompt = buildOrchestrationLaunchPrompt({
    runId: orchestrationId,
    ghToken,
    cursorApiKey,
    runtimeRef,
    bootstrapOwner: owner,
    bootstrapRepoName: repoInfo.name,
  });
  const agent = await cursorClient.launchAgent(
    launchPrompt,
    repoUrl,
    runtimeRef,
    config.model,
    `cursor-orch-run-${orchestrationId}`,
    false,
  );
  console.log(`Orchestrator ${agent.id} ${agent.status}.`);

  initialState.orchestrator_agent_id = agent.id;
  seedMainAgent(initialState, { agent_id: agent.id, status: "launching", started_at: initialState.started_at });
  await syncToRepo(repoStore, orchestrationId, initialState);

  await renderLive(repoStore, orchestrationId, config);
}

async function runInteractive(): Promise<void> {
  const config = await runRepl();
  if (!config) {
    console.log("Exiting.");
    return;
  }
  console.log(`Validating config: ${config.name} (${config.tasks.length} tasks, ${Object.keys(config.repositories).length} repos)...`);
  const configYaml = toYaml(config);
  const env = requireEnv(["CURSOR_API_KEY", "GH_TOKEN"], {
    code: "RUN-004",
    severity: "FATAL",
    title: "Missing required environment variable",
    what_happened: "run requires CURSOR_API_KEY and GH_TOKEN.",
    next_step: "Copy .env.example to .env, set required values, and rerun.",
    alternative: "Set variables inline for this invocation.",
    example: "CURSOR_API_KEY=... GH_TOKEN=... cursor-orch run --config ./orchestrator.yaml",
    exitCode: 1,
  });
  await runOrchestrationCli(config, configYaml, env.CURSOR_API_KEY!, env.GH_TOKEN!, undefined);
}

async function main(): Promise<void> {
  loadEnvFile();

  const program = new Command();
  program.name("cursor-orch").description("CLI for cursor-orch orchestration").version("0.2.0");

  program
    .command("run")
    .option("--config <path>", "Path to config YAML")
    .option("--bootstrap-repo <name>", "Bootstrap repo name")
    .action(async (opts: { config?: string; bootstrapRepo?: string }) => {
      const resolution = resolveConfig(opts.config, opts.bootstrapRepo);
      const config = resolution.config;
      printResolutionSummary(resolution);
      printNonBlockingFindings(resolution.findings);
      console.log(`Validating config: ${config.name} (${config.tasks.length} tasks, ${Object.keys(config.repositories).length} repos)...`);
      const configYaml = toYaml(config);
      const env = requireEnv(["CURSOR_API_KEY", "GH_TOKEN"], {
        code: "RUN-004",
        severity: "FATAL",
        title: "Missing required environment variable",
        what_happened: "run requires CURSOR_API_KEY and GH_TOKEN.",
        next_step: "Copy .env.example to .env, set required values, and rerun.",
        alternative: "Set variables inline for this invocation.",
        example: "CURSOR_API_KEY=... GH_TOKEN=... cursor-orch run --config ./orchestrator.yaml",
        exitCode: 1,
      });
      try {
        await runOrchestrationCli(config, configYaml, env.CURSOR_API_KEY!, env.GH_TOKEN!, opts.bootstrapRepo);
      } catch (e) {
        console.error(e);
        fail({
          code: "RUN-005",
          severity: "ERROR",
          title: "Failed to initialize orchestration runtime",
          what_happened: "A remote setup step did not complete successfully.",
          next_step: "Verify GH_TOKEN and CURSOR_API_KEY values, then retry.",
          alternative: "Rerun with the same --config after credential checks in automation.",
          example: "CURSOR_API_KEY=... GH_TOKEN=... cursor-orch run --config ./orchestrator.yaml",
          exitCode: 1,
        });
      }
    });

  program
    .command("status")
    .requiredOption("--run <id>", "Run ID")
    .option("--watch", "Live dashboard")
    .action(async (opts: { run: string; watch?: boolean }) => {
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
      const repoStore = makeRepoStore(env.GH_TOKEN!);
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
      let cfg: import("./config/types.js").OrchestratorConfig;
      try {
        cfg = parseConfig(configStr);
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
        await renderLive(repoStore, opts.run, cfg);
        return;
      }
      const events = await readEvents(repoStore, opts.run);
      await renderSnapshot(state, cfg, events);
      printNextActions(`Watch live updates: cursor-orch status --run ${opts.run} --watch`, `Inspect logs: cursor-orch logs --run ${opts.run}`);
      if (state.status === "running") {
        printNextActions(`Request stop when needed: cursor-orch stop --run ${opts.run}`);
      }
      if (state.status === "failed") {
        printNextActions(
          "Re-run with validated configuration: cursor-orch run --config ./orchestrator.yaml",
          `Fetch conversation details: cursor-orch logs --run ${opts.run}`,
        );
      }
      if (state.status === "completed" || state.status === "running") {
        process.exit(0);
      } else if (state.status === "failed") {
        process.exit(1);
      }
    });

  program
    .command("stop")
    .requiredOption("--run <id>", "Run ID")
    .action(async (opts: { run: string }) => {
      const env = requireEnv(["CURSOR_API_KEY", "GH_TOKEN"], {
        code: "STOP-001",
        severity: "FATAL",
        title: "Missing credentials for stop operation",
        what_happened: "stop requires GH_TOKEN and CURSOR_API_KEY.",
        next_step: "Set required variables and retry stop.",
        alternative: "Provide env vars inline for one-shot stop.",
        example: "CURSOR_API_KEY=... GH_TOKEN=... cursor-orch stop --run <run_id>",
        exitCode: 1,
      });
      const repoStore = makeRepoStore(env.GH_TOKEN!);
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
      const state = deserialize(content);
      const stopPayload = JSON.stringify({
        requested_at: new Date().toISOString(),
        requested_by: "cli",
      });
      console.log("Writing stop request to run branch...");
      await repoStore.writeFile(opts.run, "stop-requested.json", stopPayload);
      if (state.orchestrator_agent_id) {
        console.log(`Stopping orchestrator agent ${state.orchestrator_agent_id}...`);
        const cursorClient = new CursorClient(env.CURSOR_API_KEY!);
        try {
          await cursorClient.stopAgent(state.orchestrator_agent_id);
        } catch {
          console.warn("Failed to stop orchestrator agent via API");
          renderFeedback({
            code: "STOP-003",
            severity: "WARN",
            title: "Stop request saved, API stop was not confirmed",
            what_happened: "stop-requested.json was written but direct agent stop call failed.",
            next_step: "Monitor run status to confirm halt on next loop.",
            alternative: "Poll status in a script until state changes.",
            example: "cursor-orch status --run <run_id> --watch",
          });
        }
      }
      console.log("Stop requested. The orchestrator will halt on its next loop iteration.");
      printNextActions(
        `Confirm stop completion: cursor-orch status --run ${opts.run} --watch`,
        `Inspect latest orchestrator logs: cursor-orch logs --run ${opts.run}`,
      );
    });

  program
    .command("logs")
    .requiredOption("--run <id>", "Run ID")
    .option("--task <id>", "Task ID")
    .action(async (opts: { run: string; task?: string }) => {
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
      const repoStore = makeRepoStore(env.GH_TOKEN!);
      const cursorClient = new CursorClient(env.CURSOR_API_KEY!);
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
          process.exit(0);
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
          process.exit(0);
        }
        targetAgentId = state.orchestrator_agent_id;
      }
      let messages: import("./api/cursor-client.js").Message[];
      try {
        messages = await cursorClient.getConversation(targetAgentId!);
      } catch (e) {
        fail({
          code: "LOGS-006",
          severity: "ERROR",
          title: "Failed to fetch conversation logs",
          what_happened: `The conversation API request failed for the target agent: ${e}.`,
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
      for (const msg of messages) {
        const roleStyle = msg.role === "user" ? chalk.bold.cyan : chalk.bold.green;
        console.log(roleStyle(`[${msg.role}]`), msg.text);
        console.log();
      }
      printNextActions(`Refresh run state: cursor-orch status --run ${opts.run}`);
    });

  program
    .command("cleanup")
    .option("--older-than <days>", "Delete branches older than N days", "7")
    .option("--dry-run", "List branches without deleting")
    .action(async (opts: { olderThan: string; dryRun?: boolean }) => {
      const env = requireEnv(["GH_TOKEN"], {
        code: "CLEANUP-001",
        severity: "FATAL",
        title: "Missing GH_TOKEN",
        what_happened: "cleanup requires GitHub access.",
        next_step: "Set GH_TOKEN and rerun.",
        alternative: "Export GH_TOKEN inline.",
        example: "GH_TOKEN=... BOOTSTRAP_OWNER=owner BOOTSTRAP_REPO=repo cursor-orch cleanup",
        exitCode: 1,
      });
      const owner = getEnv("BOOTSTRAP_OWNER", {
        code: "ENV-001",
        severity: "FATAL",
        title: "BOOTSTRAP_OWNER",
        what_happened: "cleanup requires BOOTSTRAP_OWNER.",
        next_step: "Set BOOTSTRAP_OWNER.",
        alternative: "Export inline.",
        example: "BOOTSTRAP_OWNER=owner BOOTSTRAP_REPO=repo cursor-orch cleanup",
        exitCode: 1,
      });
      const repo = getEnv("BOOTSTRAP_REPO", {
        code: "ENV-001",
        severity: "FATAL",
        title: "BOOTSTRAP_REPO",
        what_happened: "cleanup requires BOOTSTRAP_REPO.",
        next_step: "Set BOOTSTRAP_REPO.",
        alternative: "Export inline.",
        example: "BOOTSTRAP_OWNER=owner BOOTSTRAP_REPO=repo cursor-orch cleanup",
        exitCode: 1,
      });
      const repoStore = new RepoStoreClient(env.GH_TOKEN!, owner, repo);
      const branches = await repoStore.listRunBranches();
      if (!branches.length) {
        console.log("No run branches found.");
        return;
      }
      const days = parseInt(opts.olderThan, 10);
      if (days !== 7) {
        console.log(`Note: age-based filtering (--older-than ${days}) is not yet implemented. Showing all branches.`);
      }
      if (opts.dryRun) {
        console.log(`Found ${branches.length} run branches (dry run - not deleting):`);
        for (const b of branches) {
          console.log(`  - ${b}`);
        }
        return;
      }
      let deleted = 0;
      for (const branch of branches) {
        const runId = branch.replace(/^run\//, "");
        await repoStore.deleteRunBranch(runId);
        console.log(`Deleted branch: ${branch}`);
        deleted += 1;
      }
      console.log(`Deleted ${deleted} run branch(es).`);
    });

  const configCmd = program.command("config").description("Configuration commands");
  configCmd
    .command("doctor")
    .option("--config <path>", "Path to config YAML")
    .option("--json", "Emit JSON")
    .option("--strict", "Non-zero on warnings")
    .option("--redact <mode>", "Redaction mode", "partial")
    .action((opts: { config?: string; json?: boolean; strict?: boolean; redact: string }) => {
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
      const errors = resolution.findings.filter((f) => f.severity === "error");
      const warnings = resolution.findings.filter((f) => f.severity === "warn");
      if (errors.length) {
        process.exit(1);
      }
      if (opts.strict && warnings.length) {
        process.exit(2);
      }
      process.exit(0);
    });

  const args = process.argv.slice(2);
  if (args.length === 0) {
    await runInteractive();
    return;
  }

  await program.parseAsync(process.argv);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
