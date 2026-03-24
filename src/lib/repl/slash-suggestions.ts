import { COMMANDS, type CommandInfo } from "../../commands.js";

export const SUGGESTION_VISIBLE_CAP = 10;

export interface SuggestionEntry {
  label: string;
  usage: string;
  description: string;
  dispatchKey: string;
}

function primaryLabelFromUsage(usage: string): string {
  const token = usage.trim().split(/\s+/)[0] ?? "";
  return token.startsWith("/") ? token : `/${token}`;
}

const ALL_SORTED: SuggestionEntry[] = (() => {
  const entries: SuggestionEntry[] = Object.values(COMMANDS).map((info: CommandInfo) => ({
    label: primaryLabelFromUsage(info.usage),
    usage: info.usage,
    description: info.description,
    dispatchKey: info.name,
  }));
  entries.sort((a, b) => a.label.localeCompare(b.label));
  return entries;
})();

export function getAllSlashSuggestions(): readonly SuggestionEntry[] {
  return ALL_SORTED;
}

export function filterSlashSuggestions(queryPrefix: string): SuggestionEntry[] {
  const q = queryPrefix.trim().toLowerCase();
  if (!q) {
    return ALL_SORTED.slice();
  }
  return ALL_SORTED.filter((e) => {
    const stem = e.label.startsWith("/") ? e.label.slice(1).toLowerCase() : e.label.toLowerCase();
    return stem.startsWith(q);
  });
}
