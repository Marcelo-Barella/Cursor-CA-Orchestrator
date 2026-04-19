import { createDefaultAgentClient } from "../../sdk/agent-client.js";
import { RepoStoreClient } from "../../api/repo-store.js";
import { ensureBootstrapRepo, resolveGithubUser, BOOTSTRAP_ENTRYPOINT, BOOTSTRAP_INSTALL_COMMAND } from "../../bootstrap.js";
import { REQUIRED_SDK_SPEC, REQUIRED_SDK_VERSION } from "../../packager.js";
import {
  canonicalizeOrchestratorConfig,
  resolveConfigPrecedence,
  toYaml,
  precedenceForField,
  sourceOfTruthForField,
  type ConfigResolution,
  type DiagnosticFinding,
  type OrchestratorConfig,
} from "../../config/index.js";
import { serialize, createInitialState, seedMainAgent, syncToRepo } from "../../state.js";
import { renderLive } from "../../dashboard.js";
import { randomUUID } from "node:crypto";
import { withOrchestratorLaunchProgress } from "../../tui/progress.js";
import { severityStyle } from "../../tui/style.js";

const MAX_RUN_ID_ATTEMPTS = 5;

export interface FeedbackOptions {
  code: string;
  severity: string;
  title: string;
  what_happened: string;
  next_step: string;
  alternative: string;
  example: string;
  exitCode: number;
}

export function printNextActions(...actions: string[]): void {
  if (!actions.length) return;
  console.log("Immediate next actions:");
  for (const action of actions) {
    console.log(`- ${action}`);
  }
}

export function renderFeedback(opts: Omit<FeedbackOptions, "exitCode">): void {
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

export function fail(opts: FeedbackOptions): never {
  renderFeedback(opts);
  process.exit(opts.exitCode);
}

export function requireEnv(names: string[], opts: FeedbackOptions): Record<string, string> {
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

export function printFindings(findings: DiagnosticFinding[]): void {
  for (const finding of findings) {
    const level = finding.severity.toUpperCase();
    const severity =
      finding.severity === "error" ? "error" : finding.severity === "warn" ? "warn" : "info";
    const style = severityStyle(severity);
    console.log(style(`${level} ${finding.code}`), finding.message);
    console.log(`Field: ${finding.field}`);
    console.log(`Source of truth: ${sourceOfTruthForField(finding.field)}`);
    console.log(`Precedence: ${precedenceForField(finding.field)}`);
    console.log(`Source: ${finding.source} (${finding.source_ref})`);
    console.log(`Why: ${finding.why_it_failed}`);
    console.log(`Recovery: ${finding.fix}`);
    if (finding.suggested_commands.length) {
      console.log("Commands:");
      for (const command of finding.suggested_commands) {
        console.log(`  - ${command}`);
      }
    }
    console.log();
  }
}

export function displayValue(fieldName: string, value: unknown): string {
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

export function printResolutionSummary(resolution: ConfigResolution): void {
  const keys = [
    "config_path",
    "name",
    "model",
    "prompt",
    "bootstrap_repo_name",
    "target.auto_create_pr",
    "target.consolidate_prs",
    "target.branch_prefix",
    "target.branch_layout",
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

export function resolveConfig(configPath: string | undefined, bootstrapRepo: string | undefined): ConfigResolution {
  const resolution = resolveConfigPrecedence(configPath, bootstrapRepo);
  const blocking = resolution.findings.filter((finding) => finding.is_blocking);
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

export function printNonBlockingFindings(findings: DiagnosticFinding[]): void {
  const nonBlocking = findings.filter((finding) => !finding.is_blocking);
  if (!nonBlocking.length) return;
  console.log();
  console.log("Diagnostics:");
  printFindings(nonBlocking);
}

export function resolveBootstrapName(
  cliName: string | undefined,
  config: { bootstrap_repo_name: string } | null,
): string {
  if (cliName) return cliName;
  if (config?.bootstrap_repo_name) return config.bootstrap_repo_name;
  return "cursor-orch-bootstrap";
}

export async function validateGithubToken(ghToken: string): Promise<void> {
  try {
    await resolveGithubUser({
      Authorization: `token ${ghToken}`,
      Accept: "application/vnd.github+json",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail({
      code: "RUN-006",
      severity: "FATAL",
      title: "Invalid GH_TOKEN",
      what_happened: `GitHub rejected GH_TOKEN during preflight validation. ${detail}`,
      next_step: "Set GH_TOKEN to a valid personal access token and rerun.",
      alternative: "Provide GH_TOKEN inline for this invocation after rotating credentials.",
      example: "CURSOR_API_KEY=... GH_TOKEN=... cursor-orch run --config ./orchestrator.yaml",
      exitCode: 1,
    });
  }
}

export function buildOrchestrationLaunchPrompt(opts: {
  runId: string;
  runtimeRef: string;
  bootstrapOwner: string;
  bootstrapRepoName: string;
}): string {
  return [
    "You are the main agent on a cursor-orch orchestrator workflow.",
    "Run the following shell commands exactly as written.",
    `export RUN_ID='${opts.runId}'`,
    `export CURSOR_ORCH_RUNTIME_REF='${opts.runtimeRef}'`,
    `export BOOTSTRAP_OWNER='${opts.bootstrapOwner}'`,
    `export BOOTSTRAP_REPO='${opts.bootstrapRepoName}'`,
    `export CURSOR_ORCH_SDK_SPEC='${REQUIRED_SDK_SPEC}'`,
    `export CURSOR_ORCH_SDK_VERSION='${REQUIRED_SDK_VERSION}'`,
    BOOTSTRAP_INSTALL_COMMAND,
    BOOTSTRAP_ENTRYPOINT,
    "If the install command fails, stop and report the exact error output.",
    "If the orchestrator command fails, report the full stderr output.",
    'If the orchestrator command succeeds, report "Bootstrap complete" followed by the last 50 lines of stdout.',
    "Do not modify repository files.",
  ].join("\n");
}

export function createRunId(): string {
  return randomUUID();
}

export async function reserveRunId(
  repoStore: Pick<RepoStoreClient, "createRun">,
  nextRunId: () => string = createRunId,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_RUN_ID_ATTEMPTS; attempt++) {
    const runId = nextRunId();
    if (await repoStore.createRun(runId)) {
      return runId;
    }
  }
  throw new Error(`Failed to reserve a unique run ID after ${MAX_RUN_ID_ATTEMPTS} attempts`);
}

export async function runOrchestrationCli(
  config: OrchestratorConfig,
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
  const orchestrationId = await reserveRunId(repoStore);
  await repoStore.writeFile(
    orchestrationId,
    "secrets.json",
    JSON.stringify({ GH_TOKEN: ghToken, CURSOR_API_KEY: cursorApiKey }),
  );

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

  const agentClient = createDefaultAgentClient(cursorApiKey);
  const repoUrl = `https://github.com/${owner}/${repoInfo.name}`;
  const launchPrompt = buildOrchestrationLaunchPrompt({
    runId: orchestrationId,
    runtimeRef,
    bootstrapOwner: owner,
    bootstrapRepoName: repoInfo.name,
  });
  const { agentId, runId: agentRunId } = await withOrchestratorLaunchProgress(
    `Launching orchestrator agent (${owner}/${repoInfo.name})`,
    async (updateMessage) => {
      updateMessage("Creating SDK agent…");
      const sdkAgent = agentClient.createCloudAgent({
        apiKey: cursorApiKey,
        model: config.model,
        repoUrl,
        startingRef: runtimeRef,
        branchName: `cursor-orch-run-${orchestrationId}`,
        autoCreatePR: false,
        skipReviewerRequest: true,
      });
      updateMessage("Sending launch prompt…");
      const run = await sdkAgent.send(launchPrompt);
      return { agentId: sdkAgent.agentId, runId: run.id };
    },
  );
  console.log(`Orchestrator ${agentId} launching (run=${agentRunId}).`);

  initialState.orchestrator_agent_id = agentId;
  seedMainAgent(initialState, {
    agent_id: agentId,
    status: "launching",
    started_at: initialState.started_at,
  });
  await syncToRepo(repoStore, orchestrationId, initialState);

  await renderLive(repoStore, orchestrationId, config);
}

export async function runCommand(opts: {
  config: string | undefined;
  bootstrapRepo: string | undefined;
}): Promise<void> {
  const resolution = resolveConfig(opts.config, opts.bootstrapRepo);
  const config = canonicalizeOrchestratorConfig(resolution.config);
  printResolutionSummary(resolution);
  printNonBlockingFindings(resolution.findings);
  console.log(
    `Validating config: ${config.name} (${config.tasks.length} tasks, ${Object.keys(config.repositories).length} repos)...`,
  );
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
  await validateGithubToken(env.GH_TOKEN!);
  try {
    await runOrchestrationCli(
      config,
      configYaml,
      env.CURSOR_API_KEY!,
      env.GH_TOKEN!,
      opts.bootstrapRepo,
    );
  } catch (error) {
    console.error(error);
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
}
