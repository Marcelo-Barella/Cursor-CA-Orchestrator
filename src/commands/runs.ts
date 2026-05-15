import { Command, Flags } from "@oclif/core";
import { cliRequireEnv, createBootstrapRepoStore } from "../lib/commands/bootstrap-repo-store.js";
import { printRunsList } from "../lib/commands/runs-list-impl.js";

export default class Runs extends Command {
  static summary = "List orchestration runs in the bootstrap repository";

  static flags = {
    limit: Flags.integer({
      char: "l",
      description: "Maximum number of runs to list (sorted newest started_at first). Default 50.",
      required: false,
      default: 50,
      min: 1,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Runs);
    const limit = flags.limit ?? 50;
    const env = cliRequireEnv(["GH_TOKEN"], {
      code: "RUNS-001",
      severity: "FATAL",
      title: "Missing GH_TOKEN",
      what_happened: "runs requires GitHub API access.",
      next_step: "Set GH_TOKEN and rerun.",
      alternative: "Export GH_TOKEN inline.",
      example: "GH_TOKEN=... cursor-orch runs",
      exitCode: 1,
    });
    const repoStore = createBootstrapRepoStore(env.GH_TOKEN);
    await printRunsList(repoStore, limit);
  }
}
