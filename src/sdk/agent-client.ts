import { jsonrepair } from "jsonrepair";
import {
  Agent as CursorAgent,
  AuthenticationError,
  ConfigurationError,
  CursorAgentError,
  NetworkError,
  RateLimitError,
  UnsupportedRunOperationError,
} from "@cursor/february";
import type {
  AgentOptions as SdkAgentOptions,
  AssistantMessage as SdkAssistantMessageChunk,
  McpServerConfig as SdkMcpServerConfig,
  Run as SdkRun,
  RunResult as SdkRunResult,
  SDKAgent as SdkAgent,
  SDKArtifact,
  SDKAssistantMessage,
  SDKMessage,
  SDKStatusMessage,
  SDKSystemMessage,
  SDKTaskMessage,
  SDKThinkingMessage,
  SDKToolUseMessage,
  SDKUserMessageEvent,
  TextBlock,
  ToolUseBlock,
} from "@cursor/february";

export {
  AuthenticationError,
  ConfigurationError,
  CursorAgentError,
  NetworkError,
  RateLimitError,
  UnsupportedRunOperationError,
};
export type {
  SdkAgent,
  SdkRun,
  SdkRunResult,
  SdkAgentOptions,
  SdkMcpServerConfig,
  SDKArtifact,
  SDKMessage,
  SDKAssistantMessage,
  SDKStatusMessage,
  SDKSystemMessage,
  SDKTaskMessage,
  SDKThinkingMessage,
  SDKToolUseMessage,
  SDKUserMessageEvent,
  SdkAssistantMessageChunk,
  TextBlock,
  ToolUseBlock,
};

export interface CreateCloudAgentOpts {
  apiKey: string;
  model: string;
  repoUrl: string;
  startingRef: string;
  branchName: string;
  autoCreatePR: boolean;
  skipReviewerRequest?: boolean;
  signal?: AbortSignal;
  mcpServers?: Record<string, SdkMcpServerConfig>;
}

export interface AgentClient {
  createCloudAgent(opts: CreateCloudAgentOpts): SdkAgent;
  resumeCloudAgent(agentId: string, opts: Partial<SdkAgentOptions>): SdkAgent;
  promptOneShot(message: string, opts: SdkAgentOptions): Promise<SdkRunResult>;
  fetchAgentConversationText?(agentId: string): Promise<string | null>;
}

const CURSOR_API_BASE_URL = "https://api.cursor.com";

export async function fetchAgentConversationTextFromApi(agentId: string, apiKey: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(`${CURSOR_API_BASE_URL}/v0/agents/${encodeURIComponent(agentId)}/conversation`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  const parts: string[] = [];
  for (const entry of messages) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { type?: unknown; text?: unknown };
    if (e.type !== "assistant_message") continue;
    if (typeof e.text !== "string") continue;
    parts.push(e.text);
  }
  if (parts.length === 0) return null;
  return parts.join("");
}

export function buildCloudAgentOptions(opts: CreateCloudAgentOpts): SdkAgentOptions {
  const options: SdkAgentOptions = {
    apiKey: opts.apiKey,
    model: { id: opts.model },
    cloud: {
      repos: [{ url: opts.repoUrl, startingRef: opts.startingRef }],
      branchName: opts.branchName,
      autoGenerateBranch: false,
      autoCreatePR: opts.autoCreatePR,
      skipReviewerRequest: opts.skipReviewerRequest ?? true,
    },
    signal: opts.signal,
  };
  if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
    options.mcpServers = opts.mcpServers;
  }
  return options;
}

export function createDefaultAgentClient(apiKey: string): AgentClient {
  return {
    createCloudAgent(opts: CreateCloudAgentOpts): SdkAgent {
      return CursorAgent.create(buildCloudAgentOptions({ ...opts, apiKey }));
    },
    resumeCloudAgent(agentId: string, opts: Partial<SdkAgentOptions>): SdkAgent {
      return CursorAgent.resume(agentId, { apiKey, ...opts });
    },
    async promptOneShot(message: string, opts: SdkAgentOptions): Promise<SdkRunResult> {
      return CursorAgent.prompt(message, { apiKey, ...opts });
    },
    async fetchAgentConversationText(agentId: string): Promise<string | null> {
      return fetchAgentConversationTextFromApi(agentId, apiKey);
    },
  };
}

export interface StreamCallbacks {
  onAssistant?: (event: SDKAssistantMessage) => void | Promise<void>;
  onThinking?: (event: SDKThinkingMessage) => void | Promise<void>;
  onToolCall?: (event: SDKToolUseMessage) => void | Promise<void>;
  onStatus?: (event: SDKStatusMessage) => void | Promise<void>;
  onSystem?: (event: SDKSystemMessage) => void | Promise<void>;
  onUser?: (event: SDKUserMessageEvent) => void | Promise<void>;
  onTask?: (event: SDKTaskMessage) => void | Promise<void>;
  onRequest?: (event: { type: "request"; agent_id: string; run_id: string; request_id: string }) => void | Promise<void>;
  onEvent?: (event: SDKMessage) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

export async function streamToCallbacks(run: SdkRun, cb: StreamCallbacks): Promise<void> {
  try {
    for await (const event of run.stream()) {
      if (cb.onEvent) {
        await cb.onEvent(event);
      }
      switch (event.type) {
        case "assistant":
          if (cb.onAssistant) await cb.onAssistant(event);
          break;
        case "thinking":
          if (cb.onThinking) await cb.onThinking(event);
          break;
        case "tool_call":
          if (cb.onToolCall) await cb.onToolCall(event);
          break;
        case "status":
          if (cb.onStatus) await cb.onStatus(event);
          break;
        case "system":
          if (cb.onSystem) await cb.onSystem(event);
          break;
        case "user":
          if (cb.onUser) await cb.onUser(event);
          break;
        case "task":
          if (cb.onTask) await cb.onTask(event);
          break;
        case "request":
          if (cb.onRequest) await cb.onRequest(event);
          break;
        default:
          break;
      }
    }
  } catch (error) {
    if (cb.onError) {
      await cb.onError(error);
    } else {
      throw error;
    }
  }
}

function concatAssistantText(messages: SDKAssistantMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    for (const block of msg.message.content) {
      if (block.type === "text") {
        parts.push(block.text);
      }
    }
  }
  return parts.join("");
}

function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      return JSON.parse(jsonrepair(trimmed));
    } catch {
      return null;
    }
  }
}

function extractFencedJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```(?:json)?\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const body = match[1];
    if (body && body.trim()) {
      blocks.push(body);
    }
  }
  return blocks;
}

function extractLastBalancedJsonObject(text: string): string | null {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (text[i] !== "}") continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j >= 0; j -= 1) {
      const ch = text[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"' && !escape) {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "}") depth += 1;
      else if (ch === "{") {
        depth -= 1;
        if (depth === 0) {
          return text.slice(j, i + 1);
        }
      }
    }
  }
  return null;
}

function strictTryParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^[\[{]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function parseAssistantJsonFromText(text: string): unknown | null {
  const fenced = extractFencedJsonBlocks(text);
  for (let i = fenced.length - 1; i >= 0; i -= 1) {
    const parsed = tryParseJson(fenced[i]!);
    if (parsed !== null) return parsed;
  }
  const bare = extractLastBalancedJsonObject(text);
  if (bare) {
    const parsed = tryParseJson(bare);
    if (parsed !== null) return parsed;
  }
  return strictTryParseJson(text);
}

export function collectAssistantMessages(run: SdkRun): Promise<SDKAssistantMessage[]> {
  const collected: SDKAssistantMessage[] = [];
  return (async () => {
    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        collected.push(event);
      }
    }
    return collected;
  })();
}

export async function captureAssistantJson(run: SdkRun): Promise<unknown | null> {
  const messages = await collectAssistantMessages(run);
  if (!messages.length) {
    const result = run.result;
    if (typeof result === "string" && result.trim()) {
      return parseAssistantJsonFromText(result);
    }
    return null;
  }
  return parseAssistantJsonFromText(concatAssistantText(messages));
}

export function parseAssistantJsonFromMessages(messages: SDKAssistantMessage[]): unknown | null {
  if (!messages.length) return null;
  return parseAssistantJsonFromText(concatAssistantText(messages));
}

export async function tryDownloadJsonArtifact(
  agent: SdkAgent,
  path: string,
): Promise<{ value: unknown | null; error: string | null }> {
  let artifacts: SDKArtifact[];
  try {
    artifacts = await agent.listArtifacts();
  } catch (error) {
    if (error instanceof UnsupportedRunOperationError) {
      return { value: null, error: "artifacts unsupported" };
    }
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
  const entry = artifacts.find((a) => a.path === path);
  if (!entry) {
    return { value: null, error: "not found" };
  }
  let buffer: Buffer;
  try {
    buffer = await agent.downloadArtifact(path);
  } catch (error) {
    if (error instanceof UnsupportedRunOperationError) {
      return { value: null, error: "download unsupported" };
    }
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
  const text = buffer.toString("utf8");
  const parsed = tryParseJson(text);
  if (parsed === null) {
    return { value: null, error: "artifact was not valid JSON" };
  }
  return { value: parsed, error: null };
}
