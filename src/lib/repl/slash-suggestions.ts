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

const EXTRA_LABELS: SuggestionEntry[] = [
  {
    label: "/repo remove",
    usage: "/repo remove <alias>",
    description: "Remove a repository (same as /repo-remove).",
    dispatchKey: "repo-remove",
  },
];

const ALL_SORTED: SuggestionEntry[] = (() => {
  const entries: SuggestionEntry[] = Object.values(COMMANDS).map((info: CommandInfo) => ({
    label: primaryLabelFromUsage(info.usage),
    usage: info.usage,
    description: info.description,
    dispatchKey: info.name,
  }));
  entries.push(...EXTRA_LABELS);
  entries.sort((a, b) => a.label.localeCompare(b.label));
  return entries;
})();

export function getAllSlashSuggestions(): readonly SuggestionEntry[] {
  return ALL_SORTED;
}

export function labelStem(label: string): string {
  return label.startsWith("/") ? label.slice(1) : label;
}

export function rotateSlashHighlight(
  highlight: number,
  matchCount: number,
  direction: "up" | "down",
): number {
  if (matchCount <= 1) {
    return 0;
  }
  if (direction === "up") {
    return (highlight - 1 + matchCount) % matchCount;
  }
  return (highlight + 1) % matchCount;
}

export function filterSlashSuggestions(queryPrefix: string): SuggestionEntry[] {
  const q = queryPrefix.trim().toLowerCase();
  if (!q) {
    return ALL_SORTED.slice();
  }
  return ALL_SORTED.filter((e) => {
    const stem = labelStem(e.label).toLowerCase();
    return stem.startsWith(q);
  });
}

export function longestCommonStemPrefix(matches: SuggestionEntry[]): string {
  if (matches.length === 0) {
    return "";
  }
  const stems = matches.map((e) => labelStem(e.label).toLowerCase());
  let i = 0;
  while (true) {
    const c = stems[0]![i];
    if (c === undefined) {
      break;
    }
    if (!stems.every((s) => s[i] === c)) {
      break;
    }
    i++;
  }
  const first = labelStem(matches[0]!.label);
  if (i === 0) {
    return "";
  }
  return first.slice(0, i);
}

export function replaceSlashQuerySegment(
  line: string,
  cursor: number,
  newQuery: string,
): { line: string; cursor: number } | null {
  const before = line.slice(0, cursor);
  const trimmedStart = before.trimStart();
  if (!trimmedStart.startsWith("/")) {
    return null;
  }
  const lead = before.length - trimmedStart.length;
  const slashPos = lead;
  const afterSlash = before.slice(slashPos + 1);
  const queryContentTrimmed = afterSlash.trimStart();
  const innerLead = afterSlash.length - queryContentTrimmed.length;
  const queryStart = slashPos + 1 + innerLead;
  const newBefore = line.slice(0, queryStart) + newQuery;
  return { line: newBefore + line.slice(cursor), cursor: newBefore.length };
}
