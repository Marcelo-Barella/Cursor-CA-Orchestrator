export interface MirroredTask {
  key: string;
  status: string;
}

export function mirrorTasksFromOrchestrationState(parsed: unknown): MirroredTask[] {
  const o = parsed as { tasks?: Array<{ name?: string; status?: string }> };
  if (!o.tasks) return [];
  return o.tasks
    .map((t, i) => ({ key: `${t.name ?? "task"}#${i}`, status: String(t.status ?? "") }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
