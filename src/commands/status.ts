import { Command, Flags } from "@oclif/core";
import { runStatusCommand } from "../lib/commands/status-impl.js";

export default class Status extends Command {
  static summary = "Show orchestration status for a run";

  static flags = {
    run: Flags.string({ required: true, description: "Run ID" }),
    watch: Flags.boolean({ description: "Live dashboard" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Status);
    await runStatusCommand({ run: flags.run!, watch: flags.watch ?? false });
  }
}
