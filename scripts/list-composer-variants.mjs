import { Cursor } from "@cursor/sdk";

const apiKey = process.env.CURSOR_API_KEY;
const modelId = process.env.MODEL_ID ?? "composer-2";

if (!apiKey) {
  console.error("Set CURSOR_API_KEY to a User API key from Cursor Settings.");
  process.exit(1);
}

const models = await Cursor.models.list({ apiKey });
const entry = models.find((m) => m.id === modelId);
if (!entry) {
  console.error(`No model with id "${modelId}". Available ids:\n${models.map((m) => m.id).sort().join("\n")}`);
  process.exit(2);
}

console.log(JSON.stringify(entry, null, 2));
