import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export const ENV_FIELD_LABELS: Record<string, string> = {
  CURSOR_API_KEY: "Cursor API key",
  GH_TOKEN: "GitHub token (repo scope)",
  BOOTSTRAP_OWNER: "Bootstrap repo GitHub owner (user or org)",
  BOOTSTRAP_REPO: "Bootstrap repository name",
};

export function isSensitiveEnvKey(key: string): boolean {
  const u = key.toUpperCase();
  return u.includes("TOKEN") || u.includes("SECRET") || u.endsWith("_KEY") || u.includes("PASSWORD");
}

export function envValueMissing(name: string): boolean {
  const v = process.env[name];
  return v === undefined || !String(v).trim();
}

export function peelSubcommandTokens(argv: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--") {
      break;
    }
    if (a.startsWith("-")) {
      i++;
      if (!a.includes("=") && argv[i] !== undefined && !argv[i].startsWith("-")) {
        i++;
      }
      continue;
    }
    out.push(a);
    i++;
  }
  return out;
}

export function getRequiredEnvKeysForCliArgs(argv: string[]): string[] | null {
  if (argv.some((a) => a === "-h" || a === "--help")) {
    return null;
  }
  if (argv.some((a) => a === "-v" || a === "--version")) {
    return null;
  }
  const chain = peelSubcommandTokens(argv);
  const root = chain[0];
  if (!root) {
    return null;
  }
  if (root === "run") {
    return ["CURSOR_API_KEY", "GH_TOKEN"];
  }
  if (root === "status" || root === "stop") {
    return ["GH_TOKEN", "BOOTSTRAP_OWNER", "BOOTSTRAP_REPO"];
  }
  if (root === "logs") {
    return ["CURSOR_API_KEY", "GH_TOKEN", "BOOTSTRAP_OWNER", "BOOTSTRAP_REPO"];
  }
  if (root === "cleanup") {
    return ["GH_TOKEN", "BOOTSTRAP_OWNER", "BOOTSTRAP_REPO"];
  }
  return null;
}

export function mergeDotenvUpdates(envPath: string, updates: Record<string, string>): void {
  const keys = Object.keys(updates);
  const keySet = new Set(keys);
  let lines: string[] = [];
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, "utf8").split("\n");
  }
  const filtered = lines.filter((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) {
      return true;
    }
    const s = t.startsWith("export ") ? t.slice("export ".length).trim() : t;
    const eq = s.indexOf("=");
    if (eq === -1) {
      return true;
    }
    const k = s.slice(0, eq).trim();
    return !keySet.has(k);
  });
  const additions = keys.map((k) => {
    const v = updates[k];
    const needsQuotes = /[\s#]/.test(v) || v === "";
    const q = needsQuotes ? `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v;
    return `${k}=${q}`;
  });
  const body = [...filtered, ...additions].join("\n");
  fs.writeFileSync(envPath, body.endsWith("\n") ? body : `${body}\n`, "utf8");
}

async function questionMasked(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!input.isTTY) {
      reject(new Error("stdin is not a TTY"));
      return;
    }
    output.write(label);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let buf = "";
    let onData: (chunk: string | Buffer) => void;
    const cleanup = (): void => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
    };
    onData = (chunk: string | Buffer) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\u0003") {
          cleanup();
          reject(new Error("cancelled"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          output.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    input.on("data", onData);
  });
}

export async function ensureEnvVarsFilled(keys: string[]): Promise<void> {
  const missing = keys.filter((k) => envValueMissing(k));
  if (!missing.length) {
    return;
  }
  if (!input.isTTY || !output.isTTY) {
    console.error(
      `Missing required environment variables: ${missing.join(", ")}. Set them in .env or export before running.`,
    );
    process.exit(1);
  }
  const collected: Record<string, string> = {};
  const rl = readline.createInterface({ input, output });
  try {
    for (const key of missing) {
      const label = ENV_FIELD_LABELS[key] ?? key;
      let value: string;
      if (isSensitiveEnvKey(key)) {
        rl.pause();
        try {
          value = (await questionMasked(`${label} (${key}): `)).trim();
        } finally {
          rl.resume();
        }
      } else {
        value = ((await rl.question(`${label} (${key}): `)) ?? "").trim();
      }
      if (!value) {
        console.error(`${key} cannot be empty.`);
        process.exit(1);
      }
      collected[key] = value;
      process.env[key] = value;
    }
  } finally {
    rl.close();
  }
  const envPath = path.join(process.cwd(), ".env");
  mergeDotenvUpdates(envPath, collected);
  console.log(`Saved to ${envPath}: ${Object.keys(collected).join(", ")}`);
}
