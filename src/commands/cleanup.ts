import { Command, Flags } from "@oclif/core";
import { runCleanupCommand } from "../lib/commands/cleanup-impl.js";

export default class Cleanup extends Command {
  static summary = "Delete old run branches on the bootstrap repo";

  static flags = {
    "older-than": Flags.string({ default: "7", description: "Delete branches older than N days" }),
    "dry-run": Flags.boolean({ description: "List branches without deleting" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Cleanup);
    await runCleanupCommand({
      olderThan: flags["older-than"],
      dryRun: flags["dry-run"],
    });
  }
}
