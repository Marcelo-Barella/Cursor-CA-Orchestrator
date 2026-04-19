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

export interface FakeRunScript {
  events?: SDKMessage[];
  result: SdkRunResult;
  artifacts?: Record<string, string>;
  throwOnWait?: unknown;
  throwOnStream?: unknown;
}

export interface FakeLaunch {
  opts: CreateCloudAgentOpts;
  agent: FakeSdkAgent;
  run: FakeSdkRun;
}

let counter = 0;

class FakeSdkRun implements SdkRun {
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

  get model(): string | undefined {
    return this.script.result.model;
  }

  get durationMs(): number | undefined {
    return this.script.result.durationMs;
  }

  get git(): { branch?: string; prUrl?: string } | undefined {
    return this.script.result.git;
  }
}

class FakeSdkAgent implements SdkAgent {
  readonly agentId: string;
  readonly scripts: FakeRunScript[];
  private readonly artifacts: Record<string, string>;
  disposed = false;

  constructor(agentId: string, scripts: FakeRunScript[]) {
    this.agentId = agentId;
    this.scripts = scripts;
    this.artifacts = { ...(scripts[0]?.artifacts ?? {}) };
  }

  async send(): Promise<SdkRun> {
    const script = this.scripts.shift();
    if (!script) {
      throw new Error(`FakeSdkAgent(${this.agentId}) received more send() calls than scripted`);
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
}

export class FakeAgentClient implements AgentClient {
  readonly launches: FakeLaunch[] = [];
  private readonly runsByAgent: Map<string, FakeRunScript[]>;
  private readonly defaultScripts: FakeRunScript[];

  constructor(opts: FakeAgentClientOptions = {}) {
    this.runsByAgent = new Map();
    for (const [k, v] of Object.entries(opts.runsByAgent ?? {})) {
      this.runsByAgent.set(k, [...v]);
    }
    this.defaultScripts = [...(opts.defaultScripts ?? [])];
  }

  createCloudAgent(opts: CreateCloudAgentOpts): SdkAgent {
    counter += 1;
    const agentId = `fake-agent-${counter}`;
    const scripts = this.runsByAgent.get(opts.branchName) ?? [this.defaultScripts.shift() ?? {
      result: { id: agentId, status: "finished", result: "" },
    }];
    const agent = new FakeSdkAgent(agentId, [...scripts]);
    this.launches.push({ opts, agent, run: null as unknown as FakeSdkRun });
    const originalSend = agent.send.bind(agent);
    agent.send = async () => {
      const run = await originalSend();
      this.launches[this.launches.length - 1]!.run = run as FakeSdkRun;
      return run;
    };
    return agent;
  }

  resumeCloudAgent(agentId: string): SdkAgent {
    const scripts = this.runsByAgent.get(agentId) ?? [];
    return new FakeSdkAgent(agentId, [...scripts]);
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
