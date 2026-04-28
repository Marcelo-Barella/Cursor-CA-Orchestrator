import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command, Flags } from "@oclif/core";
import type { InventoryManifestV1 } from "../config/types.js";

export default class Inventory extends Command {
  static description =
    "Write a declared, greenfield inventory manifest template (JSON) for use with inventory_file or config inventory:";
  static summary = "Scaffold a default inventory manifest file";

  static flags = {
    output: Flags.string({ char: "o", description: "Output file path", default: "cursor-orch-inventory.json" }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Inventory);
    const out = resolve(flags.output!);
    const manifest: InventoryManifestV1 = {
      version: 1,
      source: "declared",
      product_class: "web_app",
      layers: ["client", "api", "persistence"],
      explicit_deferrals: [],
      required_integrations: ["accounts"],
      greenfield: true,
    };
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    this.log(`Wrote ${out}`);
  }
}
