import { createStyle, padEnd, table, visibleWidth, wrapText } from "@crustjs/style";

export const tui = createStyle({ mode: "auto" });

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

export { padEnd, table, visibleWidth, wrapText };
