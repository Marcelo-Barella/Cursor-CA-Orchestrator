import type { OrchestratorConfig, TaskConfig } from "../config/types.js";

export function normalizeClaimPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

export function claimsOverlap(a: string, b: string): boolean {
  const left = normalizeClaimPath(a);
  const right = normalizeClaimPath(b);
  if (!left || !right) return false;
  if (left === "." || right === ".") return true;
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export type ClaimOverlap = { left: string; right: string; pathA: string; pathB: string };

export function findClaimOverlaps(tasks: TaskConfig[]): ClaimOverlap[] {
  const claimable = tasks.filter((t) => !t.create_repo && t.allowed_paths.length > 0);
  const out: ClaimOverlap[] = [];
  for (let i = 0; i < claimable.length; i += 1) {
    for (let j = i + 1; j < claimable.length; j += 1) {
      const a = claimable[i]!;
      const b = claimable[j]!;
      if (a.repo !== b.repo) continue;
      for (const pathA of a.allowed_paths) {
        for (const pathB of b.allowed_paths) {
          if (claimsOverlap(pathA, pathB)) {
            out.push({
              left: a.id,
              right: b.id,
              pathA: normalizeClaimPath(pathA),
              pathB: normalizeClaimPath(pathB),
            });
          }
        }
      }
    }
  }
  return out;
}

export function assertDisjointClaims(tasks: TaskConfig[]): void {
  const overlaps = findClaimOverlaps(tasks);
  if (overlaps.length === 0) return;
  const detail = overlaps
    .map((o) => `${o.left}[${o.pathA}] overlaps ${o.right}[${o.pathB}]`)
    .join("; ");
  throw new Error(`Overlapping allowed_paths claims: ${detail}`);
}

export function usesClaimsPath(config: OrchestratorConfig): boolean {
  const impl = config.tasks.filter((t) => !t.create_repo);
  return impl.length > 0 && impl.every((t) => t.allowed_paths.length > 0);
}
