export function looksLikeGithubRepoHttpsUrl(value: string): boolean {
  return /^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+/.test(value.trim());
}

export function normalizeRepoToken(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

export function extractRepoName(value: string): string | null {
  const normalized = normalizeRepoToken(value);
  if (!normalized) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) return null;
  return parts[parts.length - 1] ?? null;
}

function addRepoTokenIndex(tokenIndex: Map<string, Set<string>>, token: string | null, alias: string): void {
  if (!token) return;
  if (!tokenIndex.has(token)) {
    tokenIndex.set(token, new Set<string>());
  }
  tokenIndex.get(token)!.add(alias);
}

export function buildRepoTokenIndex(repositories: Record<string, { url: string; ref: string }>): Map<string, Set<string>> {
  const tokenIndex = new Map<string, Set<string>>();
  for (const [alias, repo] of Object.entries(repositories)) {
    addRepoTokenIndex(tokenIndex, normalizeRepoToken(alias), alias);
    addRepoTokenIndex(tokenIndex, extractRepoName(alias), alias);
    addRepoTokenIndex(tokenIndex, normalizeRepoToken(repo.url), alias);
    addRepoTokenIndex(tokenIndex, extractRepoName(repo.url), alias);
  }
  return tokenIndex;
}

export function resolveRepoTarget(
  value: string,
  repositories: Record<string, { url: string; ref: string }>,
  fallbackRef: string,
  visitedAliases: Set<string> = new Set(),
): [string, string] | null {
  const normalized = value.trim();
  if (!normalized) return null;
  if (looksLikeGithubRepoHttpsUrl(normalized)) {
    return [normalized, fallbackRef];
  }
  if (/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    return [`https://github.com/${normalized}`, fallbackRef];
  }
  const tokenIndex = buildRepoTokenIndex(repositories);
  const exactAlias = normalized in repositories ? normalized : null;
  const tokenMatches = tokenIndex.get(normalizeRepoToken(normalized));
  const uniqueAlias = tokenMatches && tokenMatches.size === 1 ? [...tokenMatches][0]! : null;
  const alias = exactAlias ?? uniqueAlias;
  if (alias && alias in repositories) {
    if (visitedAliases.has(alias)) {
      return null;
    }
    visitedAliases.add(alias);
    const rc = repositories[alias]!;
    const resolved = resolveRepoTarget(rc.url, repositories, rc.ref || fallbackRef, visitedAliases);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}
