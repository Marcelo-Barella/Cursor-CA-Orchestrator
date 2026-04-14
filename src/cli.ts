#!/usr/bin/env node
import { execute } from "@oclif/core";
import { canonicalizeOrchestratorConfig, toYaml } from "./config/index.js";
import { loadEnvFile } from "./env.js";
import { requireEnv, runOrchestrationCli } from "./lib/commands/run-impl.js";
import { ensureEnvVarsFilled, getRequiredEnvKeysForCliArgs } from "./lib/env-wizard.js";
import { runRepl } from "./repl.js";

export async function runInteractive(): Promise<void> {
  const config = await runRepl();
  if (!config) {
    console.log("Exiting.");
    return;
  }
  const runConfig = canonicalizeOrchestratorConfig(config);
  console.log(`Validating config: ${runConfig.name} (${runConfig.tasks.length} tasks, ${Object.keys(runConfig.repositories).length} repos)...`);
  const configYaml = toYaml(runConfig);
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
  await runOrchestrationCli(runConfig, configYaml, env.CURSOR_API_KEY!, env.GH_TOKEN!, undefined);
}

async function main(): Promise<void> {
  loadEnvFile();
  const args = process.argv.slice(2);
  if (args.length === 0) {
    await ensureEnvVarsFilled([
      "CURSOR_API_KEY",
      "GH_TOKEN",
      "BOOTSTRAP_OWNER",
      "BOOTSTRAP_REPO",
    ]);
    await runInteractive();
    return;
  }
  const required = getRequiredEnvKeysForCliArgs(args);
  if (required) {
    await ensureEnvVarsFilled(required);
  }
  await execute({ args, dir: import.meta.url });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
