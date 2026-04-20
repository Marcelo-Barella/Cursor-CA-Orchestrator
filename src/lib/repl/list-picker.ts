import { tui } from "../../tui/style.js";
import { parseKeysChunk } from "./tty-line-editor.js";

const DEFAULT_MAX_VISIBLE = 12;

type TtyKey =
  | { kind: "up" } | { kind: "down" } | { kind: "pgup" } | { kind: "pgdn" }
  | { kind: "home" } | { kind: "end" } | { kind: "enter" } | { kind: "space" }
  | { kind: "backspace" } | { kind: "char"; value: string } | { kind: "esc" }
  | { kind: "interrupt" } | { kind: "eof" };

export type PickOptionsBase<T> = {
  title: string;
  renderItem: (item: T) => string;
  filterText: (item: T) => string;
  initialSelectedIndex?: number;
  maxVisible?: number;
  isTTY?: boolean;
  readLine?: (prompt: string) => Promise<string | null>;
  writeLine?: (line: string) => void;
};

export type PickOptions<T> =
  | (PickOptionsBase<T> & { multiSelect?: false })
  | (PickOptionsBase<T> & { multiSelect: true });

export type PickResult<T> =
  | { kind: "selected"; value: T }
  | { kind: "selected"; values: T[] }
  | { kind: "cancelled" };

function defaultWrite(line: string): void {
  console.log(line);
}

function parseIndices(raw: string, n: number): number[] | null {
  const parts = raw
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (!parts.length) {
    return null;
  }
  const out: number[] = [];
  for (const p of parts) {
    const v = Number.parseInt(p, 10);
    if (!Number.isFinite(v) || String(v) !== p || v < 1 || v > n) {
      return null;
    }
    out.push(v - 1);
  }
  return out;
}

function findByName<T>(items: T[], filterText: (t: T) => string, raw: string): number {
  for (let i = 0; i < items.length; i++) {
    if (filterText(items[i]!) === raw) {
      return i;
    }
  }
  return -1;
}

function renderNumberedList<T>(
  items: T[],
  render: (t: T) => string,
  write: (line: string) => void,
  title: string,
): void {
  write(title);
  for (let i = 0; i < items.length; i++) {
    write(`  ${i + 1}. ${render(items[i]!)}`);
  }
}

async function runNonTtySingle<T>(items: T[], opts: PickOptionsBase<T>): Promise<PickResult<T>> {
  const write = opts.writeLine ?? defaultWrite;
  const read = opts.readLine ?? (async () => null);
  const prompt = `Choose [1-${items.length}, name, or blank to keep current]: `;
  while (true) {
    renderNumberedList(items, opts.renderItem, write, opts.title);
    const raw = await read(prompt);
    if (raw === null) {
      return { kind: "cancelled" };
    }
    const trimmed = raw.trim();
    if (trimmed === "") {
      return { kind: "cancelled" };
    }
    const idx = parseIndices(trimmed, items.length);
    if (idx && idx.length === 1) {
      return { kind: "selected", value: items[idx[0]!]! };
    }
    const byName = findByName(items, opts.filterText, trimmed);
    if (byName >= 0) {
      return { kind: "selected", value: items[byName]! };
    }
    write(`Invalid input: ${trimmed}`);
  }
}

async function runNonTtyMulti<T>(items: T[], opts: PickOptionsBase<T>): Promise<PickResult<T>> {
  const write = opts.writeLine ?? defaultWrite;
  const read = opts.readLine ?? (async () => null);
  const prompt = `Choose [e.g. 1,3,7] or blank to cancel: `;
  while (true) {
    renderNumberedList(items, opts.renderItem, write, opts.title);
    const raw = await read(prompt);
    if (raw === null) {
      return { kind: "cancelled" };
    }
    const trimmed = raw.trim();
    if (trimmed === "") {
      return { kind: "cancelled" };
    }
    const idx = parseIndices(trimmed, items.length);
    if (idx && idx.length > 0) {
      const seen = new Set<number>();
      const values: T[] = [];
      for (const i of idx) {
        if (!seen.has(i)) {
          seen.add(i);
          values.push(items[i]!);
        }
      }
      return { kind: "selected", values };
    }
    write(`Invalid input: ${trimmed}`);
  }
}

export async function pickFromList<T>(items: T[], opts: PickOptions<T>): Promise<PickResult<T>> {
  const write = opts.writeLine ?? defaultWrite;
  if (items.length === 0) {
    write(`${opts.title}`);
    write("  (No items available.)");
    return { kind: "cancelled" };
  }
  if (opts.isTTY) {
    return runTtyPicker(items, opts);
  }
  if (opts.multiSelect) {
    return runNonTtyMulti(items, opts);
  }
  return runNonTtySingle(items, opts);
}

async function runTtyPicker<T>(items: T[], opts: PickOptions<T>): Promise<PickResult<T>> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const maxVisible = Math.min(items.length, opts.maxVisible ?? DEFAULT_MAX_VISIBLE);
  const multi = "multiSelect" in opts && opts.multiSelect === true;
  const initial = Math.max(0, Math.min(items.length - 1, opts.initialSelectedIndex ?? 0));

  let filter = "";
  let highlight = initial;
  let windowStart = Math.max(0, Math.min(items.length - maxVisible, initial - Math.floor(maxVisible / 2)));
  const selected = new Set<number>();

  function visibleIndices(): number[] {
    if (filter === "") {
      return items.map((_, i) => i);
    }
    const f = filter.toLowerCase();
    const out: number[] = [];
    for (let i = 0; i < items.length; i++) {
      if (opts.filterText(items[i]!).toLowerCase().includes(f)) {
        out.push(i);
      }
    }
    return out;
  }

  let prevRendered = 0;
  function clearPrev(): void {
    if (prevRendered === 0) return;
    stdout.write("\r");
    for (let i = 0; i < prevRendered; i++) {
      stdout.write("\x1b[2K");
      if (i < prevRendered - 1) stdout.write("\x1b[1B");
    }
    if (prevRendered > 1) stdout.write(`\x1b[${prevRendered - 1}A`);
    stdout.write("\r");
  }

  function render(): void {
    clearPrev();
    const visible = visibleIndices();
    const total = visible.length;
    if (highlight >= total) highlight = Math.max(0, total - 1);
    if (highlight < windowStart) windowStart = highlight;
    if (highlight >= windowStart + maxVisible) windowStart = Math.max(0, highlight - maxVisible + 1);
    const lines: string[] = [];
    lines.push(tui.bold(opts.title));
    lines.push(`Filter: ${filter}`);
    const end = Math.min(windowStart + maxVisible, total);
    for (let i = windowStart; i < end; i++) {
      const idx = visible[i]!;
      const cursor = i === highlight ? tui.green(">") : " ";
      const mark = multi ? (selected.has(idx) ? "[x] " : "[ ] ") : "";
      lines.push(`${cursor} ${mark}${opts.renderItem(items[idx]!)}`);
    }
    lines.push(tui.dim(`${total === 0 ? 0 : highlight + 1}/${total}`));
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) stdout.write("\n");
      stdout.write(lines[i]!);
    }
    if (lines.length > 1) stdout.write(`\x1b[${lines.length - 1}A`);
    stdout.write("\r");
    prevRendered = lines.length;
  }

  return new Promise<PickResult<T>>((resolve) => {
    const wasRaw = stdin.isRaw === true;
    let residual = Buffer.alloc(0);
    let settled = false;

    function detach(): void {
      try { stdin.setRawMode(wasRaw); } catch {}
      stdin.removeListener("data", onData);
      stdin.pause();
      clearPrev();
    }

    function settle(r: PickResult<T>): void {
      if (settled) return;
      settled = true;
      detach();
      resolve(r);
    }

    function apply(k: TtyKey): void {
      const visible = visibleIndices();
      if (k.kind === "esc" || k.kind === "interrupt" || k.kind === "eof") {
        settle({ kind: "cancelled" });
        return;
      }
      if (k.kind === "enter") {
        if (multi) {
          const values: T[] = [];
          for (let i = 0; i < items.length; i++) {
            if (selected.has(i)) values.push(items[i]!);
          }
          if (values.length === 0 && visible.length > 0) {
            values.push(items[visible[highlight]!]!);
          }
          settle({ kind: "selected", values });
        } else {
          if (visible.length === 0) {
            settle({ kind: "cancelled" });
          } else {
            settle({ kind: "selected", value: items[visible[highlight]!]! });
          }
        }
        return;
      }
      if (k.kind === "space" && multi && visible.length > 0) {
        const idx = visible[highlight]!;
        if (selected.has(idx)) selected.delete(idx);
        else selected.add(idx);
      } else if (k.kind === "up") {
        if (highlight > 0) highlight--;
      } else if (k.kind === "down") {
        if (highlight < visible.length - 1) highlight++;
      } else if (k.kind === "pgup") {
        highlight = Math.max(0, highlight - maxVisible);
      } else if (k.kind === "pgdn") {
        highlight = Math.min(visible.length - 1, highlight + maxVisible);
      } else if (k.kind === "home") {
        highlight = 0;
      } else if (k.kind === "end") {
        highlight = Math.max(0, visible.length - 1);
      } else if (k.kind === "backspace") {
        if (filter.length > 0) {
          filter = filter.slice(0, -1);
          highlight = 0;
        }
      } else if (k.kind === "char") {
        filter += k.value;
        highlight = 0;
      }
      render();
    }

    function translate(raw: ReturnType<typeof parseKeysChunk>["keys"][number]): TtyKey | null {
      if (raw.kind === "up") return { kind: "up" };
      if (raw.kind === "down") return { kind: "down" };
      if (raw.kind === "left" || raw.kind === "right") return null;
      if (raw.kind === "enter" || raw.kind === "newline") return { kind: "enter" };
      if (raw.kind === "backspace") return { kind: "backspace" };
      if (raw.kind === "delete") return { kind: "backspace" };
      if (raw.kind === "interrupt") return { kind: "interrupt" };
      if (raw.kind === "eot" || raw.kind === "eof") return { kind: "eof" };
      if (raw.kind === "tab") return null;
      if (raw.kind === "char") {
        if (raw.value === " ") return { kind: "space" };
        if (raw.value === "\n") return null;
        return { kind: "char", value: raw.value };
      }
      return null;
    }

    function onData(chunk: Buffer): void {
      if (chunk.length === 1 && chunk[0] === 0x1b) {
        settle({ kind: "cancelled" });
        return;
      }
      const { keys, residual: nextResidual } = parseKeysChunk(residual, chunk);
      residual = Buffer.from(nextResidual);
      for (const k of keys) {
        const t = translate(k);
        if (t) apply(t);
        if (settled) return;
      }
    }

    try { stdin.setRawMode(true); } catch {}
    stdin.resume();
    stdin.on("data", onData);
    render();
  });
}
