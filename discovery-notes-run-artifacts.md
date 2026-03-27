# Run branch artifacts - discovery notes

## Repo store read capability
- `RepoStoreClient.readFile(runId, filename)` in `src/api/repo-store.ts` reads any file from `run/<runId>`.
- Missing files return an empty string when the API responds with not found.
- This is enough to read `summary.md` without adding new repo-store APIs.

## Core artifacts
| Artifact | Producer | Reader / access path |
| --- | --- | --- |
| `state.json` | `syncToRepo` in `src/state.ts` | `pollOnce` and TUI read via `repoStore.readFile(runId, "state.json")` then `deserialize` |
| `events.jsonl` | `appendEvent` in `src/state.ts` | `readEvents` in `src/state.ts`, used by dashboard and TUI |
| `config.yaml` | Initial writes from run flow and orchestrator updates | `loadRunConfigSnapshot` in `src/dashboard.ts`; orchestrator also reads it |
| `summary.md` | Written by orchestration progress logic in `src/orchestrator.ts` | No first-class TUI reader today; can be read with `repoStore.readFile(runId, "summary.md")` |

## Additional run files
| Artifact | Producer | Reader / access path |
| --- | --- | --- |
| `task-plan.json` | Planner flow | Read by orchestrator/planner where needed |
| `agent-<taskId>.json` | Agent workflow outputs | Read by orchestrator task hydration path |
| `stop-requested.json` | Stop command flow | Read by orchestrator stop-check logic |

## Recommendation for first iteration
- Prioritize terminal hold behavior and final inline readability first.
- Treat `summary.md` rendering in the TUI as optional follow-up unless the completion spec makes it mandatory.
