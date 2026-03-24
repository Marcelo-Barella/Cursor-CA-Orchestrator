import * as fs from "node:fs";
import { tui } from "../../tui/style.js";
import {
  filterSlashSuggestions,
  labelStem,
  longestCommonStemPrefix,
  replaceSlashQuerySegment,
  rotateSlashHighlight,
  SUGGESTION_VISIBLE_CAP,
} from "./slash-suggestions.js";

export function shouldShowSlashSuggestions(line: string, cursor: number): boolean {
  const before = line.slice(0, cursor);
  const trimmedStart = before.trimStart();
  if (!trimmedStart.startsWith("/")) {
    return false;
  }
  const afterSlash = trimmedStart.slice(1);
  if (!/\S/.test(afterSlash)) {
    return true;
  }
  return !afterSlash.includes(" ");
}

export function extractSlashQueryPrefix(line: string, cursor: number): string {
  const before = line.slice(0, cursor);
  const trimmedStart = before.trimStart();
  if (!trimmedStart.startsWith("/")) {
    return "";
  }
  return trimmedStart.slice(1).trimStart();
}

function formatSlashSuggestionLines(
  queryPrefix: string,
  highlightIndex: number,
): { lines: string[]; matchCount: number } {
  const matches = filterSlashSuggestions(queryPrefix);
  const total = matches.length;
  if (total === 0) {
    return { lines: [], matchCount: 0 };
  }
  const windowSize = SUGGESTION_VISIBLE_CAP;
  const clampedHighlight = Math.min(Math.max(0, highlightIndex), total - 1);
  const windowStart =
    total <= windowSize ? 0 : Math.min(Math.max(0, clampedHighlight - 4), total - windowSize);
  const visible = matches.slice(windowStart, windowStart + windowSize);
  const lines = visible.map((e, i) => {
    const globalIdx = windowStart + i;
    const prefix = globalIdx === clampedHighlight ? `${tui.green(">")} ` : "  ";
    return `${prefix}${tui.bold(e.label)}  ${tui.dim(e.description)}`;
  });
  if (total > windowSize) {
    lines.push(
      `  ${tui.dim(`… ${total} matches · rows ${windowStart + 1}–${windowStart + visible.length} · /help`)}`,
    );
  }
  return { lines, matchCount: total };
}

type Key =
  | { kind: "char"; value: string }
  | { kind: "enter" }
  | { kind: "backspace" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "tab" }
  | { kind: "delete" }
  | { kind: "interrupt" }
  | { kind: "eot" }
  | { kind: "eof" };

function tryParseEscape(b: Buffer): { keys: Key[]; len: number } | 0 {
  if (b.length < 2) {
    return 0;
  }
  if (b[1] !== 0x5b) {
    return { keys: [], len: 2 };
  }
  let j = 2;
  while (j < b.length && (b[j]! < 0x40 || b[j]! > 0x7e)) {
    j++;
  }
  if (j >= b.length) {
    return 0;
  }
  const code = b[j]!;
  const len = j + 1;
  if (code === 0x41) {
    return { keys: [{ kind: "up" }], len };
  }
  if (code === 0x42) {
    return { keys: [{ kind: "down" }], len };
  }
  if (code === 0x43) {
    return { keys: [{ kind: "right" }], len };
  }
  if (code === 0x44) {
    return { keys: [{ kind: "left" }], len };
  }
  if (code === 0x7e) {
    const mid = b.subarray(2, j).toString();
    if (mid === "3") {
      return { keys: [{ kind: "delete" }], len };
    }
    return { keys: [], len };
  }
  return { keys: [], len };
}

export function parseKeysChunk(residual: Buffer, chunk: Buffer): { keys: Key[]; residual: Buffer } {
  const buf = Buffer.concat([residual, chunk]);
  const keys: Key[] = [];
  let i = 0;
  while (i < buf.length) {
    const byte = buf[i]!;
    if (byte === 0x1b) {
      const sub = buf.subarray(i);
      const esc = tryParseEscape(sub);
      if (esc === 0) {
        if (sub.length === 1) {
          break;
        }
        i++;
        continue;
      }
      keys.push(...esc.keys);
      i += esc.len;
      continue;
    }
    if (byte === 0x0d || byte === 0x0a) {
      keys.push({ kind: "enter" });
      i++;
      continue;
    }
    if (byte === 0x7f || byte === 0x08) {
      keys.push({ kind: "backspace" });
      i++;
      continue;
    }
    if (byte === 0x09) {
      keys.push({ kind: "tab" });
      i++;
      continue;
    }
    if (byte === 0x03) {
      keys.push({ kind: "interrupt" });
      i++;
      continue;
    }
    if (byte === 0x04) {
      keys.push({ kind: "eot" });
      i++;
      continue;
    }
    if (byte < 0x20) {
      i++;
      continue;
    }
    const rest = buf.subarray(i).toString("utf8");
    if (!rest.length) {
      break;
    }
    const cp = rest.codePointAt(0)!;
    const ch = String.fromCodePoint(cp);
    const adv = Buffer.byteLength(ch, "utf8");
    keys.push({ kind: "char", value: ch });
    i += adv;
  }
  return { keys, residual: buf.subarray(i) };
}

function loadHistoryLines(historyPath: string): string[] {
  if (!fs.existsSync(historyPath)) {
    return [];
  }
  try {
    const text = fs.readFileSync(historyPath, "utf8");
    return text.split("\n").filter((l) => l.length > 0).slice(-500);
  } catch {
    return [];
  }
}

function appendHistoryLine(historyPath: string, line: string): void {
  const t = line.trim();
  if (!t) {
    return;
  }
  try {
    fs.appendFileSync(historyPath, `${t}\n`, "utf8");
  } catch {}
}

function clearReplPromptBlock(stdout: NodeJS.WriteStream, suggestionRows: number): void {
  if (suggestionRows > 0) {
    stdout.write("\r\x1b[2K");
    for (let i = 0; i < suggestionRows; i++) {
      stdout.write("\x1b[1B\r\x1b[2K");
    }
    stdout.write(`\x1b[${suggestionRows}A`);
  } else {
    stdout.write("\r\x1b[2K");
  }
}

export async function readReplLineTTY(historyPath: string): Promise<string | null> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  let buffer = "";
  let cursor = 0;
  let prevSuggestionRows = 0;
  const sessionHistory = loadHistoryLines(historyPath);
  let histIndex: number | null = null;
  let stashBuffer = "";
  let stashCursor = 0;
  let suggestHighlight = 0;

  let parseResidual = Buffer.alloc(0);
  const keyQueue: Key[] = [];
  const keyWaiters: Array<(k: Key) => void> = [];

  function pushKey(k: Key): void {
    const w = keyWaiters.shift();
    if (w) {
      w(k);
    } else {
      keyQueue.push(k);
    }
  }

  function onData(chunk: Buffer): void {
    const { keys, residual } = parseKeysChunk(parseResidual, chunk);
    parseResidual = Buffer.from(residual);
    for (const k of keys) {
      pushKey(k);
    }
  }

  function nextKey(): Promise<Key> {
    if (keyQueue.length) {
      return Promise.resolve(keyQueue.shift()!);
    }
    return new Promise((resolve) => {
      keyWaiters.push(resolve);
    });
  }

  const wasRaw = stdin.isRaw === true;

  return new Promise((resolve, reject) => {
    let settled = false;

    function detach(): void {
      stdin.setRawMode(wasRaw);
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onStdinEof);
      stdin.removeListener("close", onStdinEof);
      stdout.removeListener("error", onStdoutError);
      stdin.pause();
    }

    function onStdoutError(): void {
      settle(null);
    }

    function settle(line: string | null): void {
      if (settled) {
        return;
      }
      settled = true;
      detach();
      keyQueue.length = 0;
      while (keyWaiters.length) {
        keyWaiters.shift()!({ kind: "eof" });
      }
      clearReplPromptBlock(stdout, prevSuggestionRows);
      if (line === null) {
        resolve(null);
        return;
      }
      stdout.write(`> ${line}\n`);
      const t = line.trim();
      if (t) {
        if (sessionHistory.length === 0 || sessionHistory[sessionHistory.length - 1] !== line) {
          sessionHistory.push(line);
        }
        appendHistoryLine(historyPath, line);
      }
      resolve(line);
    }

    function onStdinEof(): void {
      settle(null);
    }

    try {
      stdin.setRawMode(true);
    } catch (e) {
      reject(e);
      return;
    }

    stdin.resume();

    stdin.on("data", onData);
    stdin.once("end", onStdinEof);
    stdin.once("close", onStdinEof);
    stdout.once("error", onStdoutError);

    queueMicrotask(() => {
      if (!settled && stdin.readableEnded) {
        settle(null);
      }
    });

    function redraw(): void {
      clearReplPromptBlock(stdout, prevSuggestionRows);
      stdout.write("> ");
      stdout.write(buffer);
      const show = shouldShowSlashSuggestions(buffer, cursor);
      const qp = extractSlashQueryPrefix(buffer, cursor);
      const matches = show ? filterSlashSuggestions(qp) : [];
      if (matches.length) {
        suggestHighlight = Math.min(suggestHighlight, matches.length - 1);
      } else {
        suggestHighlight = 0;
      }
      const sug = show ? formatSlashSuggestionLines(qp, suggestHighlight) : { lines: [], matchCount: 0 };
      const sugLines = sug.lines;
      if (sugLines.length) {
        stdout.write(`\n${sugLines.join("\n")}`);
        prevSuggestionRows = sugLines.length;
        stdout.write(`\x1b[${sugLines.length}A`);
        const col = 2 + [...buffer.slice(0, cursor)].length;
        stdout.write(`\r\x1b[${col}C`);
      } else {
        prevSuggestionRows = 0;
      }
    }

    function applySlashStem(stem: string): void {
      const r = replaceSlashQuerySegment(buffer, cursor, stem);
      if (r) {
        buffer = r.line;
        cursor = r.cursor;
      }
    }

    function handleSlashTab(): void {
      const qp = extractSlashQueryPrefix(buffer, cursor);
      const matches = filterSlashSuggestions(qp);
      if (matches.length === 0) {
        return;
      }
      if (matches.length === 1) {
        applySlashStem(labelStem(matches[0]!.label));
        suggestHighlight = 0;
        return;
      }
      const lcp = longestCommonStemPrefix(matches);
      const qpl = qp.toLowerCase();
      if (lcp.length > qp.length && lcp.toLowerCase().startsWith(qpl)) {
        applySlashStem(lcp);
        const hi = matches.findIndex((e) => labelStem(e.label).toLowerCase().startsWith(lcp.toLowerCase()));
        suggestHighlight = hi >= 0 ? hi : 0;
        return;
      }
      applySlashStem(labelStem(matches[suggestHighlight]!.label));
    }

    redraw();

    void (async () => {
      try {
        while (true) {
          const key = await nextKey();
          if (key.kind === "eof") {
            return;
          }
          if (key.kind === "eot") {
            if (buffer.length === 0) {
              settle(null);
              return;
            }
            if (histIndex !== null) {
              histIndex = null;
            }
            if (cursor < buffer.length) {
              buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
              suggestHighlight = 0;
              redraw();
            }
            continue;
          }
          if (key.kind === "interrupt") {
            buffer = "";
            cursor = 0;
            histIndex = null;
            stashBuffer = "";
            stashCursor = 0;
            suggestHighlight = 0;
            redraw();
            continue;
          }
          if (key.kind === "enter") {
            settle(buffer);
            return;
          }
          if (key.kind === "backspace") {
            if (histIndex !== null) {
              histIndex = null;
            }
            if (cursor > 0) {
              buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
              cursor--;
            }
            suggestHighlight = 0;
            redraw();
            continue;
          }
          if (key.kind === "delete") {
            if (histIndex !== null) {
              histIndex = null;
            }
            if (cursor < buffer.length) {
              buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
            }
            suggestHighlight = 0;
            redraw();
            continue;
          }
          if (key.kind === "left") {
            if (cursor > 0) {
              cursor--;
            }
            redraw();
            continue;
          }
          if (key.kind === "right") {
            if (cursor < buffer.length) {
              cursor++;
            }
            redraw();
            continue;
          }
          if (key.kind === "tab") {
            if (histIndex !== null) {
              histIndex = null;
            }
            if (shouldShowSlashSuggestions(buffer, cursor)) {
              handleSlashTab();
              redraw();
              continue;
            }
            redraw();
            continue;
          }
          if (key.kind === "up") {
            const show = shouldShowSlashSuggestions(buffer, cursor);
            const qp = extractSlashQueryPrefix(buffer, cursor);
            const matches = show ? filterSlashSuggestions(qp) : [];
            if (show && matches.length > 1) {
              if (histIndex !== null) {
                histIndex = null;
              }
              suggestHighlight = rotateSlashHighlight(suggestHighlight, matches.length, "up");
              redraw();
              continue;
            }
            if (!sessionHistory.length) {
              redraw();
              continue;
            }
            if (histIndex === null) {
              stashBuffer = buffer;
              stashCursor = cursor;
              histIndex = sessionHistory.length - 1;
            } else if (histIndex > 0) {
              histIndex--;
            }
            buffer = sessionHistory[histIndex]!;
            cursor = buffer.length;
            redraw();
            continue;
          }
          if (key.kind === "down") {
            const show = shouldShowSlashSuggestions(buffer, cursor);
            const qp = extractSlashQueryPrefix(buffer, cursor);
            const matches = show ? filterSlashSuggestions(qp) : [];
            if (show && matches.length > 1) {
              if (histIndex !== null) {
                histIndex = null;
              }
              suggestHighlight = rotateSlashHighlight(suggestHighlight, matches.length, "down");
              redraw();
              continue;
            }
            if (histIndex === null) {
              redraw();
              continue;
            }
            if (histIndex < sessionHistory.length - 1) {
              histIndex++;
              buffer = sessionHistory[histIndex]!;
              cursor = buffer.length;
            } else {
              histIndex = null;
              buffer = stashBuffer;
              cursor = stashCursor;
            }
            redraw();
            continue;
          }
          if (key.kind === "char") {
            if (histIndex !== null) {
              histIndex = null;
            }
            const ch = key.value;
            buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor);
            cursor += ch.length;
            suggestHighlight = 0;
            redraw();
          }
        }
      } catch (e) {
        keyQueue.length = 0;
        while (keyWaiters.length) {
          keyWaiters.shift()!({ kind: "eof" });
        }
        if (!settled) {
          settled = true;
          detach();
        }
        reject(e);
      }
    })();
  });
}
