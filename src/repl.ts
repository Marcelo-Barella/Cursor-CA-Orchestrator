import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import {
  COMMANDS,
  cmdHelp,
  cmdPromptSet,
  cmdRun,
  promptSetCommandText,
  setupSummaryLines,
  validateModelValue,
  validatePromptValue,
} from "./commands.js";
import type { OrchestratorConfig } from "./config/types.js";
import { Session } from "./session.js";
import { readVersion } from "./version.js";
import { tui } from "./tui/style.js";

const NON_MUTATION = new Set(["help", "config", "repos", "run"]);

function parseInput(raw: string): [string, string[]] {
  const parts = raw.slice(1).trim().split(/\s+/);
  if (!parts.length || !parts[0]) {
    return ["", []];
  }
  const cmd = parts[0]!;
  const args = parts.slice(1);
  if (cmd === "repo" && args[0] === "remove") {
    return ["repo-remove", args.slice(1)];
  }
  return [cmd, args];
}

function isControl(value: string, control: string): boolean {
  return value.trim().toLowerCase() === control;
}

async function runGuidedSetup(session: Session, rl: readline.Interface): Promise<OrchestratorConfig | null> {
  console.log("Welcome to cursor-orch interactive setup.");
  console.log("I will ask only what is required for your first run.");
  console.log("Controls: type 'skip' (use default), 'back' (previous step), or 'exit' (cancel setup).");

  let step = session.setupState().step;
  if (!["model", "prompt", "confirm"].includes(step)) {
    step = "model";
  }
  if (step === "confirm" && !session.hasRequiredGuidedValues()) {
    step = "model";
  }

  session.setSetupState({ active: true, step });
  session.saveSession();

  while (true) {
    if (step === "model") {
      console.log("Step 1/2 - Model");
      const raw = await rl.question("AI model [default: gpt-5]: ");
      const text = raw.trim();
      if (isControl(text, "exit")) {
        session.setSetupState({ active: true, step: "model" });
        session.saveSession();
        return null;
      }
      if (isControl(text, "back")) {
        console.log("Already at first step.");
        continue;
      }
      let value: string;
      if (text === "" || isControl(text, "skip")) {
        value = "gpt-5";
      } else {
        const err = validateModelValue(text);
        if (err) {
          console.log(tui.red(err));
          continue;
        }
        value = text;
      }
      session.setModel(value);
      session.setSetupState({ active: true, step: "prompt" });
      session.saveSession();
      console.log(`Model set to: ${value}`);
      console.log(`Equivalent command: /model ${value}`);
      step = "prompt";
      continue;
    }

    if (step === "prompt") {
      console.log("Step 2/2 - Prompt");
      console.log("Enter orchestration prompt. Finish with an empty line.");
      const lines: string[] = [];
      while (true) {
        const line = await rl.question("... ");
        if (!lines.length) {
          const stripped = line.trim();
          if (isControl(stripped, "back")) {
            step = "model";
            session.setSetupState({ active: true, step: "model" });
            session.saveSession();
            break;
          }
          if (isControl(stripped, "exit")) {
            session.setSetupState({ active: true, step: "prompt" });
            session.saveSession();
            return null;
          }
          if (isControl(stripped, "skip")) {
            console.log("Prompt is required for first run. Enter prompt text or type 'back'/'exit'.");
            continue;
          }
        }
        if (line === "") {
          const promptText = lines.join("\n");
          const err = validatePromptValue(promptText);
          if (err) {
            console.log(err);
            lines.length = 0;
            continue;
          }
          session.setPrompt(promptText);
          session.setSetupState({ active: true, step: "confirm" });
          session.saveSession();
          console.log(`Prompt captured (${promptText.length} characters).`);
          console.log("Equivalent command: /prompt");
          console.log(`Equivalent command: ${promptSetCommandText(promptText)}`);
          step = "confirm";
          break;
        }
        lines.push(line);
      }
      if (step === "model") continue;
      continue;
    }

    if (step === "confirm") {
      console.log("Setup complete. Review before execution:");
      for (const line of setupSummaryLines(session)) {
        console.log(line);
      }
      console.log("Next actions:");
      console.log("1) run   -> execute now");
      console.log("2) back  -> edit previous step");
      console.log("3) exit  -> cancel and return to REPL");
      while (true) {
        const action = (await rl.question("Choose action [run/back/exit]: ")).trim().toLowerCase();
        if (action === "back") {
          step = "prompt";
          session.setSetupState({ active: true, step: "prompt" });
          session.saveSession();
          break;
        }
        if (action === "exit") {
          session.setSetupState({ active: true, step: "confirm" });
          session.saveSession();
          return null;
        }
        if (action === "run") {
          console.log("Equivalent command: /run");
          const result = cmdRun(session);
          if ("errors" in result) {
            console.log(`Run blocked: ${result.errors[0]}`);
            console.log("Type 'back' to edit required input or 'exit' to return to REPL.");
            continue;
          }
          session.clearSetupState();
          session.saveSession();
          console.log("Setup complete. Launching run.");
          return result.config;
        }
        console.log("Invalid choice. Type run, back, or exit.");
      }
      continue;
    }
  }
}

function dispatch(cmd: string, args: string[], session: Session): string | null {
  const cmdInfo = COMMANDS[cmd];
  if (!cmdInfo) {
    return null;
  }
  if (cmd === "help") {
    return cmdHelp();
  }
  try {
    switch (cmd) {
      case "save":
        return cmdInfo.handler(session, args[0]) as string;
      case "load":
        return cmdInfo.handler(session, args[0] ?? "") as string;
      case "name":
        return cmdInfo.handler(session, args[0] ?? "") as string;
      case "model":
        return cmdInfo.handler(session, args[0] ?? "") as string;
      case "repo":
        return cmdInfo.handler(session, args[0] ?? "", args[1] ?? "", args[2] ?? "main") as string;
      case "repo-remove":
        return cmdInfo.handler(session, args[0] ?? "") as string;
      case "prompt-set":
        return cmdInfo.handler(session, args.join(" ")) as string;
      case "branch-prefix":
        return cmdInfo.handler(session, args[0] ?? "") as string;
      case "auto-pr":
        return cmdInfo.handler(session, args[0]) as string;
      case "bootstrap-repo":
        return cmdInfo.handler(session, args[0] ?? "") as string;
      case "save":
        return cmdInfo.handler(session, args[0]) as string;
      case "load":
        return cmdInfo.handler(session, args[0] ?? "") as string;
      default:
        return (cmdInfo.handler as (s: Session) => string)(session);
    }
  } catch {
    return `Usage: ${cmdInfo.usage}`;
  }
}

export async function runRepl(): Promise<OrchestratorConfig | null> {
  const session = new Session();
  const historyPath = path.join(process.env.HOME ?? ".", ".cursor-orch", "history");
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  console.log(tui.bold(`cursor-orch v${readVersion()}`));
  console.log(tui.dim("Type /help for available commands."));
  console.log(tui.dim("Next: complete guided setup (or set prompt via /prompt), then run /run."));
  console.log(tui.dim("Before /run, ensure CURSOR_API_KEY and GH_TOKEN are set (copy .env.example to .env)."));

  const resumed = session.loadSession();
  if (resumed) {
    console.log(tui.green("Resumed previous session. Type /config to review."));
  }

  let directCommandsEntered = false;
  if (session.setupState().active) {
    console.log(tui.yellow(`Resuming guided setup from step: ${session.setupState().step}.`));
  }
  const shouldRunGuided =
    session.shouldResumeGuidedSetup() || (!session.hasRequiredGuidedValues() && !directCommandsEntered);
  if (shouldRunGuided) {
    const cfg = await runGuidedSetup(session, rl);
    if (cfg) {
      rl.close();
      return cfg;
    }
  }

  try {
    while (true) {
      const text = (await rl.question("> ")).trim();
      if (!text) {
        continue;
      }
      if (!text.startsWith("/")) {
        console.log("Unknown input. Type /help for available commands.");
        continue;
      }
      directCommandsEntered = true;
      const [cmd, args] = parseInput(text);
      if (!cmd) {
        continue;
      }
      if (cmd === "exit" || cmd === "quit") {
        return null;
      }
      if (cmd === "clear") {
        console.clear();
        continue;
      }
      if (!COMMANDS[cmd]) {
        console.log(tui.red(`Unknown command: /${cmd}. Type /help for available commands.`));
        continue;
      }
      if (cmd === "prompt") {
        console.log(COMMANDS.prompt.handler(session));
        const lines: string[] = [];
        while (true) {
          const line = await rl.question("... ");
          if (line === "" && lines.length) {
            break;
          }
          lines.push(line);
        }
        const multilineText = lines.join("\n");
        const result = cmdPromptSet(session, multilineText);
        console.log(result);
        session.saveSession();
        continue;
      }
      if (cmd === "run") {
        const result = cmdRun(session);
        if ("errors" in result) {
          for (const err of result.errors) {
            console.log(tui.red(`Error: ${err}`));
          }
          continue;
        }
        session.clearSetupState();
        session.saveSession();
        return result.config;
      }
      const output = dispatch(cmd, args, session);
      if (output) {
        console.log(output);
      }
      if (!NON_MUTATION.has(cmd)) {
        session.saveSession();
      }
    }
  } finally {
    rl.close();
  }
}
