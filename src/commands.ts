import { existsSync } from "node:fs";
import * as path from "node:path";
import type { Session } from "./session.js";
import { tui } from "./tui/style.js";

export interface CommandInfo {
  name: string;
  handler: (...args: unknown[]) => unknown;
  usage: string;
  description: string;
}

export function validateModelValue(model: string): string | null {
  if (!model.trim()) {
    return "Model cannot be empty.";
  }
  return null;
}

export function validatePromptValue(prompt: string): string | null {
  if (!prompt.trim()) {
    return "Prompt is required for first run. Enter prompt text or type 'back'/'exit'.";
  }
  return null;
}

export function promptPreview(prompt: string, maxChars = 120): string {
  const text = prompt
    .split("\n")
    .map((l) => l.trim())
    .join(" ")
    .trim();
  if (!text) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...`;
}

export function promptSetCommandText(prompt: string): string {
  const escaped = prompt.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  return `/prompt-set "${escaped}"`;
}

export function setupSummaryLines(session: Session): string[] {
  const cfg = session.config;
  const model = cfg.model || "gpt-5";
  const prompt = promptPreview(cfg.prompt, 120);
  const name = cfg.name || "<empty>";
  const repoCount = Object.keys(cfg.repositories).length;
  const autoPr = cfg.target.auto_create_pr ? "on" : "off";
  return [
    `- Model: ${model}`,
    `- Prompt: ${prompt}`,
    `- Name: ${name}`,
    `- Repositories: ${repoCount}`,
    `- Branch prefix: ${cfg.target.branch_prefix}`,
    `- Auto PR: ${autoPr}`,
    `- Bootstrap repo: ${cfg.bootstrap_repo_name}`,
  ];
}

export function cmdName(session: Session, name: string): string {
  session.setName(name);
  return `${tui.green("Session name set to")} ${tui.bold(name)}`;
}

export function cmdModel(session: Session, model: string): string {
  const error = validateModelValue(model);
  if (error) {
    return tui.red(error);
  }
  session.setModel(model);
  return `${tui.green("Model set to")} ${tui.bold(model)}`;
}

export function cmdRepo(session: Session, alias: string, url: string, ref = "main"): string {
  const replaced = session.addRepo(alias, url, ref);
  const parts: string[] = [];
  if (replaced) {
    parts.push(`${tui.red("Replacing existing repo")} ${tui.bold(alias)}`);
  }
  parts.push(`${tui.green("Repo added:")} ${tui.bold(alias)} -> ${url} ${tui.dim(`(ref: ${ref})`)}`);
  return parts.join("\n");
}

export function cmdRepoRemove(session: Session, alias: string): string {
  const removed = session.removeRepo(alias);
  if (removed) {
    return `${tui.green("Repo removed:")} ${tui.bold(alias)}`;
  }
  return `${tui.red("Repo not found:")} ${tui.bold(alias)}`;
}

export function cmdRepos(session: Session): string {
  const repos = session.config.repositories;
  if (!Object.keys(repos).length) {
    return tui.dim("No repositories configured.");
  }
  const lines = [tui.bold("Repositories:")];
  for (const [alias, repo] of Object.entries(repos)) {
    lines.push(`  ${tui.bold(alias)} -> ${repo.url} ${tui.dim(`(ref: ${repo.ref})`)}`);
  }
  return lines.join("\n");
}

export function cmdPrompt(): string {
  return tui.dim("Enter your prompt (multi-line). Submit an empty line to finish:");
}

export function cmdPromptSet(session: Session, text: string): string {
  const error = validatePromptValue(text);
  if (error) {
    return tui.red(error);
  }
  session.setPrompt(text);
  return `${tui.green("Prompt set")} ${tui.dim(`(${text.length} characters)`)}`;
}

export function cmdBranchPrefix(session: Session, prefix: string): string {
  session.setBranchPrefix(prefix);
  return `${tui.green("Branch prefix set to")} ${tui.bold(prefix)}`;
}

export function cmdAutoPr(session: Session, toggle?: string): string {
  let newState: boolean;
  if (toggle === undefined) {
    newState = !session.config.target.auto_create_pr;
  } else if (toggle.toLowerCase() === "on") {
    newState = true;
  } else if (toggle.toLowerCase() === "off") {
    newState = false;
  } else {
    return `${tui.red("Invalid value:")} ${toggle}. Use ${tui.bold("on")} or ${tui.bold("off")}.`;
  }
  session.setAutoPr(newState);
  const stateLabel = newState ? tui.green("on") : tui.red("off");
  return `${tui.green("Auto PR:")} ${stateLabel}`;
}

export function cmdBootstrapRepo(session: Session, name: string): string {
  session.setBootstrapRepo(name);
  return `${tui.green("Bootstrap repo set to")} ${tui.bold(name)}`;
}

export function cmdConfig(session: Session): string {
  const cfg = session.config;
  const preview = cfg.prompt.length > 80 ? `${cfg.prompt.slice(0, 80)}...` : cfg.prompt;
  const repoCount = Object.keys(cfg.repositories).length;
  const autoPr = cfg.target.auto_create_pr ? tui.green("on") : tui.red("off");
  return [
    tui.bold("Current Configuration:"),
    `  ${tui.bold("Name:")}           ${cfg.name}`,
    `  ${tui.bold("Model:")}          ${cfg.model}`,
    `  ${tui.bold("Repositories:")}   ${repoCount}`,
    `  ${tui.bold("Prompt:")}         ${preview || tui.dim("not set")}`,
    `  ${tui.bold("Branch prefix:")}  ${cfg.target.branch_prefix}`,
    `  ${tui.bold("Auto PR:")}        ${autoPr}`,
    `  ${tui.bold("Bootstrap repo:")} ${cfg.bootstrap_repo_name}`,
  ].join("\n");
}

export function cmdSave(session: Session, savePath?: string): string {
  if (savePath) {
    session.save(savePath);
    return `${tui.green("Config saved to")} ${tui.bold(savePath)}`;
  }
  session.saveSession();
  return tui.green("Session saved.");
}

export function cmdLoad(session: Session, loadPath: string): string {
  const target = path.resolve(loadPath);
  if (!existsSync(target)) {
    return `${tui.red("File not found:")} ${loadPath}`;
  }
  try {
    session.load(target);
  } catch (e) {
    return `${tui.red("Error loading config:")} ${e}`;
  }
  return `${tui.green("Config loaded from")} ${tui.bold(loadPath)}`;
}

export function cmdHelp(): string {
  const lines = [tui.bold("Available Commands:"), ""];
  for (const info of Object.values(COMMANDS)) {
    lines.push(`  ${tui.bold(info.usage)}`);
    lines.push(`    ${tui.dim(info.description)}`);
  }
  return lines.join("\n");
}

export function cmdRun(session: Session): { errors: string[] } | { config: import("./config/types.js").OrchestratorConfig } {
  const errors = session.validate();
  if (errors.length) {
    return { errors };
  }
  return { config: session.buildConfig() };
}

export const COMMANDS: Record<string, CommandInfo> = {
  name: { name: "name", handler: cmdName as (...args: unknown[]) => unknown, usage: "/name <session-name>", description: "Set the session name." },
  model: { name: "model", handler: cmdModel as (...args: unknown[]) => unknown, usage: "/model <model-name>", description: "Set the AI model to use." },
  repo: { name: "repo", handler: cmdRepo as (...args: unknown[]) => unknown, usage: "/repo <alias> <url> [ref]", description: "Add or replace a repository." },
  "repo-remove": {
    name: "repo-remove",
    handler: cmdRepoRemove as (...args: unknown[]) => unknown,
    usage: "/repo-remove <alias>",
    description: "Remove a repository by alias.",
  },
  repos: { name: "repos", handler: cmdRepos as (...args: unknown[]) => unknown, usage: "/repos", description: "List all configured repositories." },
  prompt: { name: "prompt", handler: cmdPrompt as (...args: unknown[]) => unknown, usage: "/prompt", description: "Enter a multi-line prompt." },
  "prompt-set": {
    name: "prompt-set",
    handler: cmdPromptSet as (...args: unknown[]) => unknown,
    usage: "/prompt-set <text>",
    description: "Set the prompt text directly.",
  },
  "branch-prefix": {
    name: "branch-prefix",
    handler: cmdBranchPrefix as (...args: unknown[]) => unknown,
    usage: "/branch-prefix <prefix>",
    description: "Set the branch name prefix.",
  },
  "auto-pr": {
    name: "auto-pr",
    handler: cmdAutoPr as (...args: unknown[]) => unknown,
    usage: "/auto-pr [on|off]",
    description: "Toggle or set automatic PR creation.",
  },
  "bootstrap-repo": {
    name: "bootstrap-repo",
    handler: cmdBootstrapRepo as (...args: unknown[]) => unknown,
    usage: "/bootstrap-repo <name>",
    description: "Set the bootstrap repository name.",
  },
  config: { name: "config", handler: cmdConfig as (...args: unknown[]) => unknown, usage: "/config", description: "Show current configuration summary." },
  save: { name: "save", handler: cmdSave as (...args: unknown[]) => unknown, usage: "/save [path]", description: "Save config to file or session." },
  load: { name: "load", handler: cmdLoad as (...args: unknown[]) => unknown, usage: "/load <path>", description: "Load config from a YAML file." },
  help: { name: "help", handler: cmdHelp as (...args: unknown[]) => unknown, usage: "/help", description: "Show this help message." },
  run: { name: "run", handler: cmdRun as (...args: unknown[]) => unknown, usage: "/run", description: "Validate and run the orchestrator." },
};
