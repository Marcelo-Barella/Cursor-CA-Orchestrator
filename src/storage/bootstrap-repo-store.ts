export interface BootstrapRepoStoreDeps {
  readStateJson: () => Promise<Record<string, unknown>>;
  writeSyncedSnapshot?: (data: unknown) => Promise<void>;
}

export interface BootstrapRepoStore {
  readOrchestrationState(): Promise<Record<string, unknown>>;
  writeSyncedSnapshot(data: unknown): Promise<void>;
}

export function createBootstrapRepoStore(deps: BootstrapRepoStoreDeps): BootstrapRepoStore {
  return {
    async readOrchestrationState() {
      return deps.readStateJson();
    },
    async writeSyncedSnapshot(data: unknown) {
      if (deps.writeSyncedSnapshot) {
        await deps.writeSyncedSnapshot(data);
      }
    },
  };
}
