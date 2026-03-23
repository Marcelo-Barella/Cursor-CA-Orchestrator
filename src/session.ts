import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";
import type { OrchestratorConfig } from "./config/types.js";
import { parseConfig, toYaml } from "./config/parse.js";
import { validateConfig } from "./config/validate.js";

export const SESSION_DIR = path.join(os.homedir(), ".cursor-orch");
export const SESSION_PATH = path.join(SESSION_DIR, "session.yaml");
export const SETUP_STATE_PATH = path.join(SESSION_DIR, "setup-state.yaml");
export const VALID_SETUP_STEPS = new Set(["model", "prompt", "confirm"]);

export class Session {
  private _config: OrchestratorConfig;
  private _setupState: { active: boolean; step: string };

  constructor() {
    this._config = {
      name: "",
      model: "",
      prompt: "",
      repositories: {},
      tasks: [],
      target: { auto_create_pr: true, branch_prefix: "cursor-orch" },
      bootstrap_repo_name: "cursor-orch-bootstrap",
    };
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
    return false;
  }

  setBranchPrefix(prefix: string): void {
    this._config.target.branch_prefix = prefix;
  }

  setAutoPr(enabled: boolean): void {
    this._config.target.auto_create_pr = enabled;
  }

  setBootstrapRepo(name: string): void {
    this._config.bootstrap_repo_name = name;
  }

  get config(): OrchestratorConfig {
    return this._config;
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
    this.save(SESSION_PATH);
    this.saveSetupState();
  }

  loadSession(): boolean {
    let loaded = false;
    if (fs.existsSync(SESSION_PATH)) {
      this.load(SESSION_PATH);
      loaded = true;
    }
    this.loadSetupState();
    return loaded;
  }

  private saveSetupState(): void {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    const payload = {
      active: this._setupState.active,
      step: this._setupState.step,
    };
    fs.writeFileSync(SETUP_STATE_PATH, YAML.stringify(payload), "utf8");
  }

  private loadSetupState(): void {
    if (!fs.existsSync(SETUP_STATE_PATH)) {
      this.clearSetupState();
      return;
    }
    const raw = YAML.parse(fs.readFileSync(SETUP_STATE_PATH, "utf8"));
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
}
