import * as fs from "node:fs";
import { tui, visibleWidth } from "../../tui/style.js";
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
  | { kind: "newline" }
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

const PASTE_START = Buffer.from("\x1b[200~");
const PASTE_END = Buffer.from("\x1b[201~");
const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";

function enterKeyModsMeanNewline(mods: number): boolean {
  return mods !== 0 && (mods & 4) === 0;
}

function scanCsiTerminator(b: Buffer): number | 0 {
  if (b.length < 3 || b[0] !== 0x1b || b[1] !== 0x5b) {
    return 0;
  }
  let j = 2;
  while (j < b.length && (b[j]! < 0x40 || b[j]! > 0x7e)) {
    j++;
  }
  if (j >= b.length) {
    return 0;
  }
  return j;
}

function tryParseCsiEnterU(b: Buffer): { keys: Key[]; len: number } | 0 {
  const j = scanCsiTerminator(b);
  if (j === 0 || b[j] !== 0x75) {
    return 0;
  }
  const mid = b.subarray(2, j).toString();
  const parts = mid.split(";");
  const head = parts[0] ?? "";
  const keyStr = head.includes(":") ? (head.split(":")[0] ?? "") : head;
  const keyNum = Number.parseInt(keyStr, 10);
  if (!Number.isFinite(keyNum) || keyNum !== 13) {
    return 0;
  }
  let mods = 0;
  if (parts.length >= 2) {
    mods = Number.parseInt(parts[parts.length - 1] ?? "0", 10) || 0;
  }
  if (enterKeyModsMeanNewline(mods)) {
    return { keys: [{ kind: "newline" }], len: j + 1 };
  }
  return { keys: [{ kind: "enter" }], len: j + 1 };
}

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
    const okEnter = /^27;13;(\d+)$/.exec(mid);
    if (okEnter) {
      const mods = Number.parseInt(okEnter[1]!, 10) || 0;
      if (enterKeyModsMeanNewline(mods)) {
        return { keys: [{ kind: "newline" }], len };
      }
      return { keys: [{ kind: "enter" }], len };
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
      if (sub.length >= 2 && sub[1] === 0x0d) {
        keys.push({ kind: "newline" });
        i += 2;
        continue;
      }
      if (
        sub.length >= PASTE_START.length &&
        sub.subarray(0, PASTE_START.length).equals(PASTE_START)
      ) {
        const endPos = sub.indexOf(PASTE_END, PASTE_START.length);
        if (endPos === -1) {
          break;
        }
        const inner = sub.subarray(PASTE_START.length, endPos);
        let pi = 0;
        while (pi < inner.length) {
          const pb = inner[pi]!;
          if (pb === 0x0d) {
            if (pi + 1 < inner.length && inner[pi + 1] === 0x0a) {
              pi++;
            }
            keys.push({ kind: "char", value: "\n" });
            pi++;
            continue;
          }
          if (pb === 0x0a) {
            keys.push({ kind: "char", value: "\n" });
            pi++;
            continue;
          }
          if (pb < 0x20) {
            pi++;
            continue;
          }
          const rest = inner.subarray(pi).toString("utf8");
          const cp = rest.codePointAt(0)!;
          const ch = String.fromCodePoint(cp);
          const adv = Buffer.byteLength(ch, "utf8");
          keys.push({ kind: "char", value: ch });
          pi += adv;
        }
        i += endPos + PASTE_END.length;
        continue;
      }
      const enterU = tryParseCsiEnterU(sub);
      if (enterU !== 0) {
        keys.push(...enterU.keys);
        i += enterU.len;
        continue;
      }
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
    if (byte === 0x0d) {
      const hasLf = i + 1 < buf.length && buf[i + 1] === 0x0a;
      if (hasLf) {
        const afterCrlf = i + 2;
        if (afterCrlf < buf.length) {
          keys.push({ kind: "newline" });
          i += 2;
          continue;
        }
        i += 1;
        keys.push({ kind: "enter" });
        i += 1;
        continue;
      }
      if (i + 1 < buf.length) {
        keys.push({ kind: "newline" });
        i += 1;
        continue;
      }
      keys.push({ kind: "enter" });
      i++;
      continue;
    }
    if (byte === 0x0a) {
      keys.push({ kind: "newline" });
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

const HISTORY_CAP = 500;

export function encodeHistoryEntry(line: string): string {
  return JSON.stringify(line);
}

export function parseHistoryFileText(text: string): string[] {
  const rawLines = text.split("\n").filter((l) => l.length > 0);
  const out: string[] = [];
  for (const l of rawLines) {
    try {
      const v = JSON.parse(l) as unknown;
      if (typeof v === "string") {
        out.push(v);
        continue;
      }
    } catch {
      // legacy newline-delimited plain text
    }
    out.push(l);
  }
  return out.slice(-HISTORY_CAP);
}

function loadHistoryLines(historyPath: string): string[] {
  if (!fs.existsSync(historyPath)) {
    return [];
  }
  try {
    const text = fs.readFileSync(historyPath, "utf8");
    return parseHistoryFileText(text);
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
    fs.appendFileSync(historyPath, `${encodeHistoryEntry(line)}\n`, "utf8");
  } catch {}
}

function lineWrapPhysicalRows(text: string, columns: number): number {
  if (columns <= 0) {
    return 1;
  }
  const w = visibleWidth(text);
  return Math.max(1, Math.ceil(w / columns));
}

function editLinePrefix(editIndex: number): string {
  return editIndex === 0 ? "> " : ". ";
}

function totalEditPhysicalRows(lines: string[], columns: number): number {
  let t = 0;
  for (let i = 0; i < lines.length; i++) {
    t += lineWrapPhysicalRows(editLinePrefix(i) + lines[i]!, columns);
  }
  return t;
}

function totalSuggestionPhysicalRows(sugLines: string[], columns: number): number {
  let t = 0;
  for (const s of sugLines) {
    t += lineWrapPhysicalRows(s, columns);
  }
  return t;
}

function editCursorPhysicalOffsetUp(
  lines: string[],
  row: number,
  col: number,
  columns: number,
): number {
  if (columns <= 0) {
    return row;
  }
  let up = 0;
  for (let i = 0; i < row; i++) {
    up += lineWrapPhysicalRows(editLinePrefix(i) + lines[i]!, columns);
  }
  up += Math.floor((col - 1) / columns);
  return up;
}

function totalEditPhysicalRowsFromLineIndex(lines: string[], startIdx: number, columns: number): number {
  let t = 0;
  for (let i = startIdx; i < lines.length; i++) {
    t += lineWrapPhysicalRows(editLinePrefix(i) + lines[i]!, columns);
  }
  return t;
}

function clearPromptFrame(
  stdout: NodeJS.WriteStream,
  prevCursorPhysicalOffset: number,
  prevFramePhysicalRows: number,
): void {
  const total = prevFramePhysicalRows;
  if (total <= 0) {
    return;
  }
  if (prevCursorPhysicalOffset > 0) {
    stdout.write(`\x1b[${prevCursorPhysicalOffset}A`);
  }
  stdout.write("\r");
  for (let i = 0; i < total; i++) {
    stdout.write("\x1b[2K");
    if (i < total - 1) {
      stdout.write("\x1b[1B");
    }
  }
  if (total > 1) {
    stdout.write(`\x1b[${total - 1}A`);
  }
  stdout.write("\r");
}

export function bufferEditLines(buffer: string): string[] {
  return buffer.split("\n");
}

export function cursorEditRowAndCol(buffer: string, cursor: number): { row: number; col: number } {
  let lineStart = 0;
  let row = 0;
  for (let p = 0; p < cursor && p < buffer.length; p++) {
    if (buffer[p] === "\n") {
      row++;
      lineStart = p + 1;
    }
  }
  const col = 2 + [...buffer.slice(lineStart, cursor)].length;
  return { row, col };
}

function positionEditCursor(stdout: NodeJS.WriteStream, lines: string[], toRow: number, toCol: number): void {
  const h = lines.length;
  const eolCol = 2 + [...lines[h - 1]!].length;
  if (toRow === h - 1 && toCol === eolCol) {
    return;
  }
  stdout.write("\r");
  stdout.write(`\x1b[${h - 1 - toRow}A`);
  stdout.write("\r");
  stdout.write(`\x1b[${toCol}C`);
}

export async function readReplLineTTY(historyPath: string): Promise<string | null> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  let buffer = "";
  let cursor = 0;
  let prevFramePhysicalRows = 1;
  let prevCursorPhysicalOffset = 0;
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

  const wasRaw = stdin.isRaw === true;

  return new Promise((resolve, reject) => {
    let settled = false;

    function detach(): void {
      stdout.write(BRACKETED_PASTE_OFF);
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
      clearPromptFrame(stdout, prevCursorPhysicalOffset, prevFramePhysicalRows);
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

    stdout.write(BRACKETED_PASTE_ON);

    stdin.on("data", onData);
    stdin.once("end", onStdinEof);
    stdin.once("close", onStdinEof);
    stdout.once("error", onStdoutError);

    queueMicrotask(() => {
      if (!settled && stdin.readableEnded) {
        settle(null);
      }
    });

    let redrawScheduled = false;
    function redraw(): void {
      if (settled) {
        return;
      }
      clearPromptFrame(stdout, prevCursorPhysicalOffset, prevFramePhysicalRows);
      const lines = bufferEditLines(buffer);
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) {
          stdout.write("\n");
        }
        stdout.write(i === 0 ? "> " : ". ");
        stdout.write(lines[i]!);
      }
      const { row, col } = cursorEditRowAndCol(buffer, cursor);
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
      const cols = stdout.columns ?? 0;
      const editPhy = totalEditPhysicalRows(lines, cols);
      const sugPhy = totalSuggestionPhysicalRows(sugLines, cols);
      const framePhy = editPhy + sugPhy;
      const cursorPhyUp = editCursorPhysicalOffsetUp(lines, row, col, cols);
      if (sugLines.length) {
        positionEditCursor(stdout, lines, row, col);
        stdout.write(`\n${sugLines.join("\n")}`);
        const rowsBelowCursor = totalEditPhysicalRowsFromLineIndex(lines, row + 1, cols);
        const upCount = sugPhy + rowsBelowCursor;
        stdout.write(`\x1b[${upCount}A`);
        stdout.write("\r");
        stdout.write(`\x1b[${col}C`);
      } else {
        positionEditCursor(stdout, lines, row, col);
      }
      prevFramePhysicalRows = framePhy;
      prevCursorPhysicalOffset = cursorPhyUp;
    }

    function scheduleRedraw(): void {
      if (settled) {
        return;
      }
      if (redrawScheduled) {
        return;
      }
      redrawScheduled = true;
      queueMicrotask(() => {
        redrawScheduled = false;
        if (!settled) {
          redraw();
        }
      });
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
          let key: Key;
          if (keyQueue.length > 0) {
            key = keyQueue.shift()!;
          } else {
            key = await new Promise<Key>((resolve) => {
              keyWaiters.push(resolve);
            });
          }
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
              scheduleRedraw();
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
            scheduleRedraw();
            continue;
          }
          if (key.kind === "enter") {
            settle(buffer);
            return;
          }
          if (key.kind === "newline") {
            if (histIndex !== null) {
              histIndex = null;
            }
            buffer = buffer.slice(0, cursor) + "\n" + buffer.slice(cursor);
            cursor += 1;
            suggestHighlight = 0;
            scheduleRedraw();
            continue;
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
            scheduleRedraw();
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
            scheduleRedraw();
            continue;
          }
          if (key.kind === "left") {
            if (cursor > 0) {
              cursor--;
            }
            scheduleRedraw();
            continue;
          }
          if (key.kind === "right") {
            if (cursor < buffer.length) {
              cursor++;
            }
            scheduleRedraw();
            continue;
          }
          if (key.kind === "tab") {
            if (histIndex !== null) {
              histIndex = null;
            }
            if (shouldShowSlashSuggestions(buffer, cursor)) {
              handleSlashTab();
              scheduleRedraw();
              continue;
            }
            scheduleRedraw();
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
              scheduleRedraw();
              continue;
            }
            if (!sessionHistory.length) {
              scheduleRedraw();
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
            scheduleRedraw();
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
              scheduleRedraw();
              continue;
            }
            if (histIndex === null) {
              scheduleRedraw();
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
            scheduleRedraw();
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
            scheduleRedraw();
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
