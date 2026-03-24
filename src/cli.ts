#!/usr/bin/env node
import { execute } from "@oclif/core";
import { toYaml } from "./config/index.js";
import { loadEnvFile } from "./env.js";
import { requireEnv, runOrchestrationCli } from "./lib/commands/run-impl.js";
import { runRepl } from "./repl.js";

export async function runInteractive(): Promise<void> {
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
  const args = process.argv.slice(2);
  if (args.length === 0) {
    await runInteractive();
    return;
  }
  await execute({ args, dir: import.meta.url });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
