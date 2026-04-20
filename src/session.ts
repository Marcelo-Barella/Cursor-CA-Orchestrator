import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";
import type { McpServerConfig, OrchestratorConfig } from "./config/types.js";
import { parseConfig, parseMcpServers, toYaml } from "./config/parse.js";
import { validateConfig, validateMcpServers } from "./config/validate.js";

type SessionPaths = {
  sessionDir: string;
  sessionPath: string;
  setupStatePath: string;
  historyPath: string;
};

function hashSessionKey(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, 16);
}

function resolveSessionKey(cwd: string, sessionKey: string | undefined): string {
  if (sessionKey && sessionKey.trim()) {
    return sessionKey.trim();
  }
  return path.resolve(cwd);
}

export function resolveSessionPaths(opts?: {
  homeDir?: string;
  cwd?: string;
  sessionKey?: string;
}): SessionPaths {
  const homeDir = opts?.homeDir ?? os.homedir();
  const cwd = opts?.cwd ?? process.cwd();
  const sessionKey = resolveSessionKey(cwd, opts?.sessionKey ?? process.env.CURSOR_ORCH_SESSION_KEY);
  const sessionRoot = path.join(homeDir, ".cursor-orch");
  const sessionDir = path.join(sessionRoot, "sessions", hashSessionKey(sessionKey));
  return {
    sessionDir,
    sessionPath: path.join(sessionDir, "session.yaml"),
    setupStatePath: path.join(sessionDir, "setup-state.yaml"),
    historyPath: path.join(sessionDir, "history"),
  };
}

const defaultSessionPaths = resolveSessionPaths();
export const SESSION_DIR = defaultSessionPaths.sessionDir;
export const SESSION_PATH = defaultSessionPaths.sessionPath;
export const SETUP_STATE_PATH = defaultSessionPaths.setupStatePath;
export const VALID_SETUP_STEPS = new Set(["model", "prompt", "confirm"]);

function extractMcpServersPayload(raw: unknown): unknown {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("MCP servers file must contain a mapping");
  }
  const o = raw as Record<string, unknown>;
  if ("mcp_servers" in o && o.mcp_servers !== undefined) {
    return o.mcp_servers;
  }
  if ("mcpServers" in o && o.mcpServers !== undefined) {
    return o.mcpServers;
  }
  return o;
}

export function createDefaultOrchestratorConfig(): OrchestratorConfig {
  return {
    name: "",
    model: "",
    prompt: "",
    repositories: {},
    tasks: [],
    target: { auto_create_pr: true, consolidate_prs: true, branch_prefix: "cursor-orch", branch_layout: "consolidated" },
    bootstrap_repo_name: "cursor-orch-bootstrap",
    mcp_servers: {},
  };
}
const LEGACY_SESSION_ROOT = path.join(os.homedir(), ".cursor-orch");
const LEGACY_SESSION_PATH = path.join(LEGACY_SESSION_ROOT, "session.yaml");
const LEGACY_SETUP_STATE_PATH = path.join(LEGACY_SESSION_ROOT, "setup-state.yaml");

export class Session {
  private _config: OrchestratorConfig;
  private _setupState: { active: boolean; step: string };
  private readonly sessionPaths: SessionPaths;

  constructor(paths: SessionPaths = resolveSessionPaths()) {
    this.sessionPaths = paths;
    this._config = createDefaultOrchestratorConfig();
    this._setupState = { active: false, step: "model" };
  }

  setName(name: string): void {
    this._config.name = name;
  }

  setModel(model: string): void {
    this._config.model = model;
  }

  setPrompt(prompt: string): void {
    this._config.prompt = prompt;
  }

  addRepo(alias: string, url: string, ref = "main"): boolean {
    const replaced = alias in this._config.repositories;
    this._config.repositories[alias] = { url, ref };
    return replaced;
  }

  removeRepo(alias: string): boolean {
    if (alias in this._config.repositories) {
      delete this._config.repositories[alias];
      return true;
    }
    for (const [key, repo] of Object.entries(this._config.repositories)) {
      if (repo.url === alias) {
        delete this._config.repositories[key];
        return true;
      }
    }
    return false;
  }

  setBranchPrefix(prefix: string): void {
    this._config.target.branch_prefix = prefix;
  }

  setAutoPr(enabled: boolean): void {
    this._config.target.auto_create_pr = enabled;
  }

  setConsolidatePrs(enabled: boolean): void {
    this._config.target.consolidate_prs = enabled;
  }

  setBootstrapRepo(name: string): void {
    this._config.bootstrap_repo_name = name;
  }

  setMcpServer(name: string, server: McpServerConfig): void {
    validateMcpServers({ [name]: server });
    const current = this._config.mcp_servers ?? {};
    current[name] = server;
    this._config.mcp_servers = current;
  }

  removeMcpServer(name: string): boolean {
    const current = this._config.mcp_servers;
    if (current && name in current) {
      delete current[name];
      return true;
    }
    return false;
  }

  clearMcpServers(): void {
    this._config.mcp_servers = {};
  }

  importMcpServersFromMap(map: Record<string, McpServerConfig>): { added: string[]; replaced: string[] } {
    const parsed = parseMcpServers(map);
    validateMcpServers(parsed);
    const current = this._config.mcp_servers ?? {};
    const added: string[] = [];
    const replaced: string[] = [];
    for (const [name, server] of Object.entries(parsed)) {
      if (name in current) {
        replaced.push(name);
      } else {
        added.push(name);
      }
      current[name] = server;
    }
    this._config.mcp_servers = current;
    return { added, replaced };
  }

  importMcpServersFromFile(filePath: string): { added: string[]; replaced: string[] } {
    const content = fs.readFileSync(filePath, "utf8");
    const raw = YAML.parse(content);
    const candidate = extractMcpServersPayload(raw);
    return this.importMcpServersFromMap(candidate as Record<string, McpServerConfig>);
  }

  resetSessionToDefaults(): void {
    this._config = createDefaultOrchestratorConfig();
    this.clearSetupState();
  }

  get config(): OrchestratorConfig {
    return this._config;
  }

  get historyPath(): string {
    return this.sessionPaths.historyPath;
  }

  buildConfig(): OrchestratorConfig {
    return this._config;
  }

  hasRequiredGuidedValues(): boolean {
    return Boolean(this._config.model.trim()) && Boolean(this._config.prompt.trim());
  }

  setupState(): { active: boolean; step: string } {
    return { ...this._setupState };
  }

  setSetupState(opts: { active?: boolean; step?: string }): void {
    if (opts.active !== undefined) {
      this._setupState.active = opts.active;
    }
    if (opts.step !== undefined) {
      this._setupState.step = VALID_SETUP_STEPS.has(opts.step) ? opts.step : "model";
    }
  }

  clearSetupState(): void {
    this._setupState = { active: false, step: "model" };
  }

  shouldResumeGuidedSetup(): boolean {
    const active = this._setupState.active;
    if (!active) return false;
    const step = this._setupState.step;
    if (!VALID_SETUP_STEPS.has(step)) return true;
    if (step === "confirm") return true;
    return !this.hasRequiredGuidedValues();
  }

  validate(): string[] {
    try {
      validateConfig(this._config);
    } catch (e) {
      return [String(e)];
    }
    return [];
  }

  save(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, toYaml(this._config), "utf8");
  }

  load(filePath: string): void {
    this._config = parseConfig(fs.readFileSync(filePath, "utf8"));
  }

  saveSession(): void {
    this.save(this.sessionPaths.sessionPath);
    this.saveSetupState();
  }

  loadSession(): boolean {
    const configPath = this.resolveReadablePath(this.sessionPaths.sessionPath, LEGACY_SESSION_PATH);
    const loaded = Boolean(configPath);
    if (configPath) {
      this.load(configPath);
    }
    this.loadSetupState();
    return loaded;
  }

  private saveSetupState(): void {
    fs.mkdirSync(this.sessionPaths.sessionDir, { recursive: true });
    const payload = {
      active: this._setupState.active,
      step: this._setupState.step,
    };
    fs.writeFileSync(this.sessionPaths.setupStatePath, YAML.stringify(payload), "utf8");
  }

  private loadSetupState(): void {
    const setupStatePath = this.resolveReadablePath(this.sessionPaths.setupStatePath, LEGACY_SETUP_STATE_PATH);
    if (!setupStatePath) {
      this.clearSetupState();
      return;
    }
    const raw = YAML.parse(fs.readFileSync(setupStatePath, "utf8"));
    if (typeof raw !== "object" || raw === null) {
      this.clearSetupState();
      return;
    }
    const o = raw as Record<string, unknown>;
    const active = Boolean(o.active);
    let step = String(o.step ?? "model");
    if (!VALID_SETUP_STEPS.has(step)) {
      step = "model";
    }
    this._setupState = { active, step };
  }

  private resolveReadablePath(primaryPath: string, fallbackPath: string): string | null {
    if (fs.existsSync(primaryPath)) {
      return primaryPath;
    }
    if (fs.existsSync(fallbackPath)) {
      return fallbackPath;
    }
    return null;
  }
}
