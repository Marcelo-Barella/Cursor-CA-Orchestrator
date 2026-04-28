import { existsSync } from "node:fs";
import * as path from "node:path";
import type { McpServerConfig } from "./config/types.js";
import { copyToClipboard } from "./lib/clipboard.js";
import { countOrchestrationPromptTokens } from "./lib/prompt-token-count.js";
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

export function validateRepoAdd(alias: string, url: string): string | null {
  if (!alias) {
    return "Repository alias cannot be empty.";
  }
  if (!url) {
    return "Repository URL cannot be empty.";
  }
  return null;
}

export function formatRepoEquivalentCommand(alias: string, url: string, ref: string): string {
  const a = alias.trim();
  const u = url.trim();
  const r = ref.trim() || "main";
  if (r === "main") {
    return `/repo ${a} ${u}`;
  }
  return `/repo ${a} ${u} ${r}`;
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
  const model = cfg.model || "composer-2";
  const prompt = promptPreview(cfg.prompt, 120);
  const name = cfg.name || "<empty>";
  const repoCount = Object.keys(cfg.repositories).length;
  const autoPr = cfg.target.auto_create_pr ? "on" : "off";
  const consolidatePrs = cfg.target.consolidate_prs ? "on" : "off";
  return [
    `- Model: ${model}`,
    `- Prompt: ${prompt}`,
    `- Name: ${name}`,
    `- Repositories: ${repoCount}`,
    `- Branch prefix: ${cfg.target.branch_prefix}`,
    `- Auto PR: ${autoPr}`,
    `- Consolidate PRs: ${consolidatePrs}`,
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
  const aliasNorm = alias.trim();
  const urlNorm = url.trim();
  const error = validateRepoAdd(aliasNorm, urlNorm);
  if (error) {
    return tui.red(error);
  }
  const refNorm = ref.trim() || "main";
  const replaced = session.addRepo(aliasNorm, urlNorm, refNorm);
  const parts: string[] = [];
  if (replaced) {
    parts.push(`${tui.red("Replacing existing repo")} ${tui.bold(aliasNorm)}`);
  }
  parts.push(`${tui.green("Repo added:")} ${tui.bold(aliasNorm)} -> ${urlNorm} ${tui.dim(`(ref: ${refNorm})`)}`);
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

function formatPromptSetAck(text: string): string {
  const tokens = countOrchestrationPromptTokens(text);
  return `${tui.green("Prompt set")} ${tui.dim(`(${text.length} characters, ${tokens} tokens)`)}`;
}

export function cmdPromptSet(session: Session, text: string): string {
  const error = validatePromptValue(text);
  if (error) {
    return tui.red(error);
  }
  session.setPrompt(text);
  return formatPromptSetAck(text);
}

export function cmdPrompt(session: Session): string {
  const text = session.config.prompt;
  const lines = [tui.bold("Prompt:"), text || tui.dim("(not set)")];
  const copied = copyToClipboard(text);
  lines.push(
    copied ? tui.green("Copied to clipboard.") : tui.yellow("Could not copy to clipboard."),
  );
  return lines.join("\n");
}

export function cmdTokens(session: Session): string {
  const text = session.config.prompt;
  if (!text.trim()) {
    return `${tui.dim("Prompt not set.")} ${tui.dim("(0 tokens)")}`;
  }
  const tokens = countOrchestrationPromptTokens(text);
  return `${tui.bold("Tokens (GPT-4o estimate):")} ${tokens} ${tui.dim(`(${text.length} characters)`)}`;
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

export function cmdConsolidatePrs(session: Session, toggle?: string): string {
  let newState: boolean;
  if (toggle === undefined) {
    newState = !session.config.target.consolidate_prs;
  } else if (toggle.toLowerCase() === "on") {
    newState = true;
  } else if (toggle.toLowerCase() === "off") {
    newState = false;
  } else {
    return `${tui.red("Invalid value:")} ${toggle}. Use ${tui.bold("on")} or ${tui.bold("off")}.`;
  }
  session.setConsolidatePrs(newState);
  const stateLabel = newState ? tui.green("on") : tui.red("off");
  return `${tui.green("Consolidate PRs:")} ${stateLabel}`;
}

export function cmdBootstrapRepo(session: Session, name: string): string {
  session.setBootstrapRepo(name);
  return `${tui.green("Bootstrap repo set to")} ${tui.bold(name)}`;
}

export function cmdConfigClear(session: Session): string {
  session.resetSessionToDefaults();
  return [
    tui.green("Cleared session configuration."),
    tui.dim("All settings reset to defaults; guided setup state cleared."),
  ].join("\n");
}

export function cmdConfig(session: Session): string {
  const cfg = session.config;
  const preview = cfg.prompt.length > 80 ? `${cfg.prompt.slice(0, 80)}...` : cfg.prompt;
  const repoCount = Object.keys(cfg.repositories).length;
  const autoPr = cfg.target.auto_create_pr ? tui.green("on") : tui.red("off");
  const consolidatePrs = cfg.target.consolidate_prs ? tui.green("on") : tui.red("off");
  return [
    tui.bold("Current Configuration:"),
    `  ${tui.bold("Name:")}           ${cfg.name}`,
    `  ${tui.bold("Model:")}          ${cfg.model}`,
    `  ${tui.bold("Repositories:")}   ${repoCount}`,
    `  ${tui.bold("Prompt:")}         ${preview || tui.dim("not set")}`,
    `  ${tui.bold("Branch prefix:")}  ${cfg.target.branch_prefix}`,
    `  ${tui.bold("Auto PR:")}        ${autoPr}`,
    `  ${tui.bold("Consolidate PRs:")} ${consolidatePrs}`,
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

const MCP_SECRET_KEY_RE = /authorization|token|secret|password|api[_-]?key/i;

function redactMcpValue(key: string, value: string): string {
  if (!MCP_SECRET_KEY_RE.test(key)) {
    return value;
  }
  return tui.dim("<redacted>");
}

function formatMcpServer(name: string, server: McpServerConfig): string[] {
  const lines: string[] = [`  ${tui.bold(name)} ${tui.dim(`(${server.type})`)}`];
  if (server.type === "stdio") {
    lines.push(`    command: ${server.command}`);
    if (server.args && server.args.length) {
      lines.push(`    args: ${server.args.join(" ")}`);
    }
    if (server.env && Object.keys(server.env).length) {
      const entries = Object.entries(server.env).map(([k, v]) => `${k}=${redactMcpValue(k, v)}`);
      lines.push(`    env: ${entries.join(", ")}`);
    }
    if (server.cwd) {
      lines.push(`    cwd: ${server.cwd}`);
    }
    return lines;
  }
  lines.push(`    url: ${server.url}`);
  if (server.headers && Object.keys(server.headers).length) {
    const entries = Object.entries(server.headers).map(([k, v]) => `${k}: ${redactMcpValue(k, v)}`);
    lines.push(`    headers: ${entries.join(", ")}`);
  }
  if (server.auth) {
    const parts: string[] = [`CLIENT_ID=${server.auth.CLIENT_ID}`];
    if (server.auth.CLIENT_SECRET !== undefined) {
      parts.push(`CLIENT_SECRET=${tui.dim("<redacted>")}`);
    }
    if (server.auth.scopes && server.auth.scopes.length) {
      parts.push(`scopes=${server.auth.scopes.join(",")}`);
    }
    lines.push(`    auth: ${parts.join(", ")}`);
  }
  return lines;
}

function cmdMcpList(session: Session): string {
  const servers = session.config.mcp_servers ?? {};
  const names = Object.keys(servers);
  if (!names.length) {
    return tui.dim("No MCP servers configured.");
  }
  const lines = [tui.bold("MCP Servers:")];
  for (const name of names) {
    for (const entry of formatMcpServer(name, servers[name]!)) {
      lines.push(entry);
    }
  }
  return lines.join("\n");
}

function cmdMcpImport(session: Session, filePath: string): string {
  if (!filePath) {
    return tui.red("Usage: /mcp import <path>");
  }
  const target = path.resolve(filePath);
  if (!existsSync(target)) {
    return `${tui.red("File not found:")} ${filePath}`;
  }
  let result: { added: string[]; replaced: string[] };
  try {
    result = session.importMcpServersFromFile(target);
  } catch (e) {
    return `${tui.red("Error importing MCP servers:")} ${e instanceof Error ? e.message : String(e)}`;
  }
  const parts: string[] = [];
  if (result.added.length) {
    parts.push(`${tui.green("Added:")} ${result.added.join(", ")}`);
  }
  if (result.replaced.length) {
    parts.push(`${tui.yellow("Replaced:")} ${result.replaced.join(", ")}`);
  }
  if (!parts.length) {
    return tui.dim("No MCP servers found in file.");
  }
  return parts.join("\n");
}

function cmdMcpRemove(session: Session, name: string): string {
  if (!name) {
    return tui.red("Usage: /mcp remove <name>");
  }
  const removed = session.removeMcpServer(name);
  if (removed) {
    return `${tui.green("MCP server removed:")} ${tui.bold(name)}`;
  }
  return `${tui.red("MCP server not found:")} ${tui.bold(name)}`;
}

function cmdMcpClear(session: Session): string {
  session.clearMcpServers();
  return tui.green("All MCP servers removed.");
}

export function cmdMcp(session: Session, sub?: string, arg?: string): string {
  const action = (sub ?? "list").toLowerCase();
  switch (action) {
    case "list":
      return cmdMcpList(session);
    case "import":
      return cmdMcpImport(session, arg ?? "");
    case "remove":
      return cmdMcpRemove(session, arg ?? "");
    case "clear":
      return cmdMcpClear(session);
    default:
      return tui.red(`Unknown /mcp subcommand: ${sub}. Use list, import, remove, or clear.`);
  }
}

export function cmdRun(session: Session): { errors: string[] } | { config: import("./config/types.js").OrchestratorConfig } {
  const errors = session.validate();
  if (errors.length) {
    return { errors };
  }
  return { config: session.buildConfig() };
}

export type RefreshResult =
  | { ok: true; count: number; fetchedAt: Date }
  | { ok: false; error: Error };

export type RefreshDeps = {
  refreshModels: () => Promise<RefreshResult>;
  refreshRepos: () => Promise<RefreshResult>;
  ageModels: () => Promise<Date | null>;
  ageRepos: () => Promise<Date | null>;
};

function ageLabel(d: Date | null): string {
  if (!d) return "none";
  const ms = Date.now() - d.getTime();
  const s = Math.max(1, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export async function cmdRefresh(target: string | undefined, deps: RefreshDeps | null): Promise<string> {
  if (!deps) {
    return tui.red("CURSOR_API_KEY not set; cannot refresh cache.");
  }
  if (target === undefined) {
    const [m, r] = await Promise.all([deps.ageModels(), deps.ageRepos()]);
    return [
      `${tui.bold("Cache ages:")}`,
      `  models:       ${ageLabel(m)}`,
      `  repositories: ${ageLabel(r)}`,
    ].join("\n");
  }
  const t = target.toLowerCase();
  if (t === "models") {
    const r = await deps.refreshModels();
    return r.ok
      ? `${tui.green(`models refreshed:`)} ${r.count} items (age: ${ageLabel(r.fetchedAt)})`
      : tui.red(`models refresh failed: ${r.error.message}`);
  }
  if (t === "repos") {
    const r = await deps.refreshRepos();
    return r.ok
      ? `${tui.green(`repositories refreshed:`)} ${r.count} items (age: ${ageLabel(r.fetchedAt)})`
      : tui.red(`repositories refresh failed: ${r.error.message}`);
  }
  if (t === "all") {
    const m = await deps.refreshModels();
    const r = await deps.refreshRepos();
    const lines: string[] = [];
    lines.push(m.ok
      ? `${tui.green(`models refreshed:`)} ${m.count} items (age: ${ageLabel(m.fetchedAt)})`
      : tui.red(`models refresh failed: ${m.error.message}`));
    lines.push(r.ok
      ? `${tui.green(`repositories refreshed:`)} ${r.count} items (age: ${ageLabel(r.fetchedAt)})`
      : tui.red(`repositories refresh failed: ${r.error.message}`));
    return lines.join("\n");
  }
  return tui.red("Usage: /refresh [models|repos|all]");
}

export const COMMANDS: Record<string, CommandInfo> = {
  name: { name: "name", handler: cmdName as (...args: unknown[]) => unknown, usage: "/name <session-name>", description: "Set the session name." },
  model: { name: "model", handler: cmdModel as (...args: unknown[]) => unknown, usage: "/model <model-name>", description: "Set the AI model to use." },
  repo: {
    name: "repo",
    handler: cmdRepo as (...args: unknown[]) => unknown,
    usage: "/repo [<alias> <url> [ref]]",
    description:
      "Add or replace a repository. With no args or only an alias or URL, the REPL prompts for the rest (type exit or EOF to cancel).",
  },
  "repo-remove": {
    name: "repo-remove",
    handler: cmdRepoRemove as (...args: unknown[]) => unknown,
    usage: "/repo-remove <alias>",
    description: "Remove a repository by alias.",
  },
  repos: { name: "repos", handler: cmdRepos as (...args: unknown[]) => unknown, usage: "/repos", description: "List all configured repositories." },
  "prompt-set": {
    name: "prompt-set",
    handler: cmdPromptSet as (...args: unknown[]) => unknown,
    usage: "/prompt-set <text>",
    description:
      "Set the prompt text directly. For greenfield runs, state product class, required layers, and what is out of scope; use `inventory` in saved YAML (see README) for a machine-readable layer manifest.",
  },
  prompt: {
    name: "prompt",
    handler: cmdPrompt as (...args: unknown[]) => unknown,
    usage: "/prompt",
    description: "Print the full configured prompt and copy it to the clipboard.",
  },
  tokens: {
    name: "tokens",
    handler: cmdTokens as (...args: unknown[]) => unknown,
    usage: "/tokens",
    description: "Show token count for the orchestration prompt (GPT-4o tokenizer estimate).",
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
  "consolidate-prs": {
    name: "consolidate-prs",
    handler: cmdConsolidatePrs as (...args: unknown[]) => unknown,
    usage: "/consolidate-prs [on|off]",
    description: "Toggle or set one consolidated PR per repo at end (requires Auto PR on).",
  },
  "bootstrap-repo": {
    name: "bootstrap-repo",
    handler: cmdBootstrapRepo as (...args: unknown[]) => unknown,
    usage: "/bootstrap-repo <name>",
    description: "Set the bootstrap repository name.",
  },
  config: {
    name: "config",
    handler: cmdConfig as (...args: unknown[]) => unknown,
    usage: "/config [clear]",
    description: "Show current configuration summary, or reset all settings to defaults.",
  },
  mcp: {
    name: "mcp",
    handler: cmdMcp as (...args: unknown[]) => unknown,
    usage: "/mcp [list|import <path>|remove <name>|clear]",
    description: "Configure MCP servers passed to orchestrator cloud agents.",
  },
  save: { name: "save", handler: cmdSave as (...args: unknown[]) => unknown, usage: "/save [path]", description: "Save config to file or session." },
  load: { name: "load", handler: cmdLoad as (...args: unknown[]) => unknown, usage: "/load <path>", description: "Load config from a YAML file." },
  help: { name: "help", handler: cmdHelp as (...args: unknown[]) => unknown, usage: "/help", description: "Show this help message." },
  run: { name: "run", handler: cmdRun as (...args: unknown[]) => unknown, usage: "/run", description: "Validate and run the orchestrator." },
  refresh: {
    name: "refresh",
    handler: (() => "") as (...args: unknown[]) => unknown,
    usage: "/refresh [models|repos|all]",
    description: "Bypass TTL and re-fetch Cursor API cache; no args prints cache ages.",
  },
};
