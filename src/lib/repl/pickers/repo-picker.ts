import { tui } from "../../../tui/style.js";
import type { RepoInfo } from "../../../api/cursor-api-client.js";
import type { CacheResult } from "../../cache/disk-cache.js";
import type { PickOptions, PickResult } from "../list-picker.js";

export type RepoPickerAdd = { alias: string; url: string; ref: string };

export type RepoPickerDeps = {
  listRepositories: () => Promise<CacheResult<RepoInfo[]>>;
  pick: (items: RepoInfo[], opts: PickOptions<RepoInfo>) => Promise<PickResult<RepoInfo>>;
  readLine: (prompt: string) => Promise<string | null>;
  writeLine: (line: string) => void;
  existingAliases: Set<string>;
  addRepo: (alias: string, url: string, ref: string) => void;
  fallbackInteractive: () => Promise<void>;
  isTTY: boolean;
};

function humanAge(d: Date): string {
  const ms = Date.now() - d.getTime();
  const s = Math.max(1, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export async function runRepoPicker(deps: RepoPickerDeps): Promise<void> {
  const res = await deps.listRepositories();
  if (!res.data || res.data.length === 0) {
    deps.writeLine(tui.dim("Repository list unavailable; enter value manually."));
    await deps.fallbackInteractive();
    return;
  }
  if (res.source === "stale" && res.fetchedAt) {
    deps.writeLine(tui.dim(`Using stale repositories cache (age: ${humanAge(res.fetchedAt)}).`));
  }
  const picked = await deps.pick(res.data, {
    title: "Select repositories",
    renderItem: (r) => `${r.owner}/${r.name}`,
    filterText: (r) => `${r.owner}/${r.name}`,
    multiSelect: true,
    isTTY: deps.isTTY,
  });
  if (picked.kind === "cancelled" || !("values" in picked)) {
    return;
  }

  const batchAliases = new Set<string>();
  for (const r of picked.values) {
    const aliasPrompt = `Alias for ${r.owner}/${r.name} [${r.name}]: `;
    let alias = "";
    while (true) {
      const raw = await deps.readLine(aliasPrompt);
      if (raw === null) {
        return;
      }
      const candidate = raw.trim() || r.name;
      if (deps.existingAliases.has(candidate) || batchAliases.has(candidate)) {
        deps.writeLine(tui.red(`Alias "${candidate}" already used. Enter different alias:`));
        const retry = await deps.readLine("Alias: ");
        if (retry === null) {
          return;
        }
        const retryCand = retry.trim();
        if (!retryCand) {
          continue;
        }
        if (deps.existingAliases.has(retryCand) || batchAliases.has(retryCand)) {
          continue;
        }
        alias = retryCand;
        break;
      }
      alias = candidate;
      break;
    }
    const refRaw = await deps.readLine("Ref [main]: ");
    if (refRaw === null) {
      return;
    }
    const ref = refRaw.trim() || "main";
    deps.addRepo(alias, r.repository, ref);
    batchAliases.add(alias);
  }
}
