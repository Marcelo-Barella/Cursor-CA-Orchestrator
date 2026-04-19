import type { RepoStoreClient } from "../api/repo-store.js";
import type { SDKMessage } from "./agent-client.js";

const DEFAULT_BATCH_MS = 2000;
const DEFAULT_BATCH_SIZE = 16;
const MAX_TRANSCRIPT_BYTES = 512 * 1024;
const TRANSCRIPT_KEEP_BYTES = 256 * 1024;

export interface TranscriptRecord {
  seq: number;
  timestamp: string;
  event: SDKMessage;
}

export interface TranscriptWriterOptions {
  repoStore: RepoStoreClient;
  runId: string;
  taskId: string;
  batchMs?: number;
  batchSize?: number;
}

export interface TranscriptWriter {
  enqueue(event: SDKMessage): void;
  flush(): Promise<void>;
}

function serializeRecord(record: TranscriptRecord): string {
  return JSON.stringify(record);
}

function truncateTranscript(content: string): string {
  if (Buffer.byteLength(content, "utf8") <= MAX_TRANSCRIPT_BYTES) {
    return content;
  }
  const encoded = Buffer.from(content, "utf8");
  const tail = encoded.subarray(Math.max(0, encoded.length - TRANSCRIPT_KEEP_BYTES));
  const text = tail.toString("utf8");
  const firstNl = text.indexOf("\n");
  if (firstNl >= 0) {
    return text.slice(firstNl + 1);
  }
  return text;
}

function transcriptPath(taskId: string): string {
  return `transcripts/${taskId}.jsonl`;
}

export function createTranscriptWriter(opts: TranscriptWriterOptions): TranscriptWriter {
  const batchMs = opts.batchMs ?? DEFAULT_BATCH_MS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  let buffer: TranscriptRecord[] = [];
  let seq = 0;
  let timer: NodeJS.Timeout | null = null;
  let flushPromise: Promise<void> = Promise.resolve();

  const filePath = transcriptPath(opts.taskId);

  const doFlush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const lines = batch.map(serializeRecord).join("\n") + "\n";
    try {
      await opts.repoStore.updateFile(opts.runId, filePath, (current) => {
        const next = current ? `${current}${lines}` : lines;
        return truncateTranscript(next);
      });
    } catch {
      /* best-effort; transcripts are advisory */
    }
  };

  const scheduleFlush = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flushPromise = flushPromise.then(doFlush).catch(() => {});
    }, batchMs);
  };

  return {
    enqueue(event: SDKMessage): void {
      seq += 1;
      buffer.push({ seq, timestamp: new Date().toISOString(), event });
      if (buffer.length >= batchSize) {
        flushPromise = flushPromise.then(doFlush).catch(() => {});
        return;
      }
      scheduleFlush();
    },
    async flush(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      flushPromise = flushPromise.then(doFlush).catch(() => {});
      await flushPromise;
    },
  };
}
