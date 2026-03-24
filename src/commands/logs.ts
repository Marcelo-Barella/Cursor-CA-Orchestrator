import { Command, Flags } from "@oclif/core";
import { runLogsCommand } from "../lib/commands/logs-impl.js";

export default class Logs extends Command {
  static summary = "Fetch orchestrator or task conversation logs";

  static flags = {
    run: Flags.string({ required: true, description: "Run ID" }),
    task: Flags.string({ description: "Task ID" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Logs);
    await runLogsCommand(flags);
  }
}
