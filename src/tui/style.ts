const ESC = "\u001b[";
const ANSI_RE = /\u001b\[[0-9;]*m/g;

function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "") return true;
  return process.stdout.isTTY === true;
}

function wrap(code: string, text: string): string {
  if (!colorEnabled()) return text;
  return `${ESC}${code}m${text}${ESC}0m`;
}

export function fg256(n: number, text: string): string {
  if (!colorEnabled()) return text;
  return `${ESC}38;5;${n}m${text}${ESC}0m`;
}

export const tui = {
  bold: (s: string) => wrap("1", s),
  dim: (s: string) => wrap("2", s),
  red: (s: string) => wrap("31", s),
  green: (s: string) => wrap("32", s),
  yellow: (s: string) => wrap("33", s),
  blue: (s: string) => wrap("34", s),
  magenta: (s: string) => wrap("35", s),
  cyan: (s: string) => wrap("36", s),
};

export type Severity = "error" | "warn" | "info";

export function severityStyle(sev: Severity): (text: string) => string {
  if (sev === "error") return (text) => tui.red(text);
  if (sev === "warn") return (text) => tui.yellow(text);
  return (text) => tui.cyan(text);
}

export function roleSuccess(text: string): string {
  return tui.green(text);
}

export function roleError(text: string): string {
  return tui.red(text);
}

export function roleWarn(text: string): string {
  return tui.yellow(text);
}

export function roleInfo(text: string): string {
  return tui.cyan(text);
}

export function roleMuted(text: string): string {
  return tui.dim(text);
}

export function roleAccent(text: string): string {
  return tui.bold(text);
}

export function visibleWidth(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

export function padEnd(s: string, width: number): string {
  const pad = width - visibleWidth(s);
  if (pad <= 0) return s;
  return s + " ".repeat(pad);
}

export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > width) {
    out.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
  }
  out.push(remaining);
  return out;
}

export function table(headers: string[], rows: string[][]): string {
  const cols = headers.length;
  const allRows = [headers, ...rows];
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(...allRows.map((row) => visibleWidth(row[c] ?? ""))),
  );
  const sep = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const fmt = (row: string[]) =>
    "| " + row.map((cell, i) => padEnd(cell ?? "", widths[i]!)).join(" | ") + " |";
  return [fmt(headers), sep, ...rows.map(fmt)].join("\n");
}
