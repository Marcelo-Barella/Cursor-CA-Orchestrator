import { Command, Flags } from "@oclif/core";
import { runConfigDoctorCommand } from "../../lib/commands/config-doctor-impl.js";

export default class ConfigDoctor extends Command {
  static summary = "Validate config and show resolution";

  static flags = {
    config: Flags.string({ description: "Path to config YAML" }),
    json: Flags.boolean({ description: "Emit JSON" }),
    strict: Flags.boolean({ description: "Non-zero on warnings" }),
    redact: Flags.string({ default: "partial", description: "Redaction mode" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ConfigDoctor);
    this.exit(
      runConfigDoctorCommand({
        config: flags.config,
        json: flags.json,
        strict: flags.strict,
        redact: flags.redact,
      }),
    );
  }
}
