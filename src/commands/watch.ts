import { Command, Flags } from "@oclif/core";
import { runStatusCommand } from "../lib/commands/status-impl.js";

export default class Watch extends Command {
  static summary = "Live dashboard for a run (same as status --watch)";

  static flags = {
    run: Flags.string({ required: true, description: "Run ID" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Watch);
    await runStatusCommand({ run: flags.run, watch: true });
  }
}
