import type { ModelSelection } from "@cursor/sdk";
import type { ModelSelectionConfig } from "../../src/config/types.js";
import type {
  AgentClient,
  CreateCloudAgentOpts,
  SDKArtifact,
  SDKMessage,
  SdkAgent,
  SdkAgentOptions,
  SdkRun,
  SdkRunResult,
} from "../../src/sdk/agent-client.js";

type SdkRunGit = NonNullable<SdkRunResult["git"]>;

function modelConfigToSelection(c: ModelSelectionConfig): ModelSelection {
  return {
    id: c.id,
    params: c.params?.map((p) => ({ id: p.id, value: p.value })),
  };
}

export interface FakeRunScript {
  events?: SDKMessage[];
  result: SdkRunResult;
  artifacts?: Record<string, string>;
  throwOnWait?: unknown;
  throwOnStream?: unknown;
  /** When set, send() throws before starting the run (launch-time failure). */
  sendThrows?: unknown;
}

export interface FakeLaunch {
  opts: CreateCloudAgentOpts;
  agent: FakeSdkAgent;
  run: FakeSdkRun;
  prompt?: string;
}

let counter = 0;

export class FakeSdkRun implements SdkRun {
  readonly id: string;
  readonly agentId: string;
  readonly createdAt?: number;
  status: "running" | "finished" | "error" | "cancelled" = "running";
  readonly script: FakeRunScript;

  constructor(agentId: string, script: FakeRunScript) {
    counter += 1;
    this.id = `fake-run-${counter}`;
    this.agentId = agentId;
    this.script = script;
  }

  supports(): boolean {
    return true;
  }

  unsupportedReason(): string | undefined {
    return undefined;
  }

  async *stream(): AsyncGenerator<SDKMessage, void> {
    if (this.script.throwOnStream) {
      throw this.script.throwOnStream;
    }
    for (const event of this.script.events ?? []) {
      yield event;
    }
  }

  async conversation(): Promise<never[]> {
    return [];
  }

  async wait(): Promise<SdkRunResult> {
    if (this.script.throwOnWait) {
      throw this.script.throwOnWait;
    }
    this.status = this.script.result.status;
    return this.script.result;
  }

  async cancel(): Promise<void> {
    this.status = "cancelled";
  }

  onDidChangeStatus(): () => void {
    return () => {};
  }

  get result(): string | undefined {
    return this.script.result.result;
  }

  get model(): ModelSelection | undefined {
    return this.script.result.model;
  }

  get durationMs(): number | undefined {
    return this.script.result.durationMs;
  }

  get git(): SdkRunGit | undefined {
    return this.script.result.git;
  }
}

class FakeSdkAgent implements SdkAgent {
  readonly agentId: string;
  readonly model: ModelSelection | undefined;
  readonly scripts: FakeRunScript[];
  private readonly artifacts: Record<string, string>;
  disposed = false;

  constructor(agentId: string, model: ModelSelection | undefined, scripts: FakeRunScript[]) {
    this.agentId = agentId;
    this.model = model;
    this.scripts = scripts;
    this.artifacts = { ...(scripts[0]?.artifacts ?? {}) };
  }

  async send(_message?: string): Promise<SdkRun> {
    const script = this.scripts.shift();
    if (!script) {
      throw new Error(`FakeSdkAgent(${this.agentId}) received more send() calls than scripted`);
    }
    if (script.sendThrows !== undefined) {
      throw script.sendThrows instanceof Error ? script.sendThrows : new Error(String(script.sendThrows));
    }
    Object.assign(this.artifacts, script.artifacts ?? {});
    return new FakeSdkRun(this.agentId, script);
  }

  close(): void {
    this.disposed = true;
  }

  async reload(): Promise<void> {}

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposed = true;
  }

  async listArtifacts(): Promise<SDKArtifact[]> {
    return Object.keys(this.artifacts).map((path) => ({
      path,
      sizeBytes: Buffer.byteLength(this.artifacts[path] ?? "", "utf8"),
      updatedAt: new Date().toISOString(),
    }));
  }

  async downloadArtifact(path: string): Promise<Buffer> {
    const content = this.artifacts[path];
    if (content === undefined) {
      throw new Error(`artifact not found: ${path}`);
    }
    return Buffer.from(content, "utf8");
  }
}

export interface FakeAgentClientOptions {
  runsByAgent?: Record<string, FakeRunScript[]>;
  defaultScripts?: FakeRunScript[];
  conversationText?: string | null | ((agentId: string) => string | null);
  sendPreDelayMs?: number;
  /** First N createCloudAgent calls throw before any agent is returned. */
  createFailCount?: number;
}

export class FakeAgentClient implements AgentClient {
  readonly launches: FakeLaunch[] = [];
  readonly conversationCalls: string[] = [];
  readonly sentPrompts: string[] = [];
  maxConcurrentSends = 0;
  private _activeSends = 0;
  private readonly sendPreDelayMs: number;
  private readonly runsByAgent: Map<string, FakeRunScript[]>;
  private readonly defaultScripts: FakeRunScript[];
  private readonly conversationText: string | null | ((agentId: string) => string | null) | undefined;
  private readonly createFailCount: { value: number };

  constructor(opts: FakeAgentClientOptions = {}) {
    this.runsByAgent = new Map();
    for (const [k, v] of Object.entries(opts.runsByAgent ?? {})) {
      this.runsByAgent.set(k, [...v]);
    }
    this.defaultScripts = [...(opts.defaultScripts ?? [])];
    this.conversationText = opts.conversationText;
    this.sendPreDelayMs = opts.sendPreDelayMs ?? 0;
    this.createFailCount = { value: opts.createFailCount ?? 0 };
  }

  async fetchAgentConversationText(agentId: string): Promise<string | null> {
    this.conversationCalls.push(agentId);
    if (this.conversationText === undefined) return null;
    if (typeof this.conversationText === "function") {
      return this.conversationText(agentId);
    }
    return this.conversationText;
  }

  async createCloudAgent(opts: CreateCloudAgentOpts): Promise<SdkAgent> {
    if (this.createFailCount.value > 0) {
      this.createFailCount.value -= 1;
      throw new Error("fake createCloudAgent failure");
    }
    counter += 1;
    const agentId = `fake-agent-${counter}`;
    const scripts = this.runsByAgent.get(opts.startingRef) ?? [this.defaultScripts.shift() ?? {
      result: { id: agentId, status: "finished", result: "" },
    }];
    const agent = new FakeSdkAgent(agentId, modelConfigToSelection(opts.model), [...scripts]);
    this.launches.push({ opts, agent, run: null as unknown as FakeSdkRun });
    const originalSend = agent.send.bind(agent);
    agent.send = async (message?: string) => {
      if (typeof message === "string") {
        this.sentPrompts.push(message);
        this.launches[this.launches.length - 1]!.prompt = message;
      }
      this._activeSends += 1;
      this.maxConcurrentSends = Math.max(this.maxConcurrentSends, this._activeSends);
      try {
        if (this.sendPreDelayMs > 0) {
          await new Promise<void>((r) => setTimeout(r, this.sendPreDelayMs));
        }
        const run = await originalSend();
        this.launches[this.launches.length - 1]!.run = run as FakeSdkRun;
        return run;
      } finally {
        this._activeSends -= 1;
      }
    };
    return agent;
  }

  async resumeCloudAgent(agentId: string, opts: Partial<SdkAgentOptions>): Promise<SdkAgent> {
    const scripts = this.runsByAgent.get(agentId) ?? [];
    return new FakeSdkAgent(agentId, opts.model, [...scripts]);
  }

  async promptOneShot(_message: string, _opts: SdkAgentOptions): Promise<SdkRunResult> {
    const script = this.defaultScripts.shift();
    if (!script) {
      return { id: "fake-prompt", status: "finished", result: "" };
    }
    return script.result;
  }
}

export function assistantText(text: string): SDKMessage {
  return {
    type: "assistant",
    agent_id: "a",
    run_id: "r",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

export function statusMessage(status: "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | "EXPIRED"): SDKMessage {
  return { type: "status", agent_id: "a", run_id: "r", status };
}
