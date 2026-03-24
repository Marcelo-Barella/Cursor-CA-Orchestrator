import { Command, Flags } from "@oclif/core";
import { runCommand } from "../lib/commands/run-impl.js";

export default class Run extends Command {
  static summary = "Run orchestration from validated config";

  static flags = {
    config: Flags.string({ description: "Path to config YAML" }),
    "bootstrap-repo": Flags.string({ description: "Bootstrap repo name" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Run);
    await runCommand({
      config: flags.config,
      bootstrapRepo: flags["bootstrap-repo"],
    });
  }
}
