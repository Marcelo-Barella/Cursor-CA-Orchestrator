import { Command, Flags } from "@oclif/core";
import { runStopCommand } from "../lib/commands/stop-impl.js";

export default class Stop extends Command {
  static summary = "Request stop for an orchestration run";

  static flags = {
    run: Flags.string({ required: true, description: "Run ID" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Stop);
    await runStopCommand({
      run: flags.run,
    });
  }
}
