import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import tty from "node:tty";
import type { Interface as ReadlineInterface } from "node:readline/promises";
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
import { readReplLineTTY } from "./lib/repl/tty-line-editor.js";
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

function isInteractiveTty(): boolean {
  return (
    tty.isatty(0) &&
    tty.isatty(1) &&
    typeof process.stdin.setRawMode === "function"
  );
}

type RlHolder = { rl: ReadlineInterface };

async function readLineOrEof(rl: ReadlineInterface, prompt: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      rl.off("close", onClose);
      action();
    };
    const onClose = (): void => {
      finish(() => {
        resolve(null);
      });
    };
    rl.once("close", onClose);
    void rl
      .question(prompt)
      .then((line) => finish(() => resolve(line)))
      .catch((err: unknown) => finish(() => reject(err)));
  });
}

async function runGuidedSetup(
  session: Session,
  holder: RlHolder,
  historyPath: string,
): Promise<OrchestratorConfig | null> {
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
      const raw = await readLineOrEof(holder.rl, "AI model [default: gpt-5]: ");
      if (raw === null) {
        return null;
      }
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
      const ttyPrompt = isInteractiveTty();
      if (ttyPrompt) {
        console.log(
          "Enter your orchestration prompt as plain text (TTY: Ctrl+J or Alt+Enter for newline, Enter to submit). Shift+Enter also sends Enter here and cannot be a newline unless your terminal maps it to a line feed. A leading / starts a command; here use plain text, or type back/exit.",
        );
      } else {
        console.log(
          "Enter your orchestration prompt as plain text at the prompt (single line in this environment). A leading / starts a command; here use plain text, or type back/exit.",
        );
      }
      let raw: string | null;
      if (ttyPrompt) {
        holder.rl.close();
        process.stdin.resume();
        raw = await readReplLineTTY(historyPath);
        holder.rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: true,
        });
      } else {
        raw = await readLineOrEof(holder.rl, "> ");
      }
      if (raw === null) {
        session.setSetupState({ active: true, step: "prompt" });
        session.saveSession();
        return null;
      }
      const stripped = raw.trim();
      if (isControl(stripped, "back")) {
        step = "model";
        session.setSetupState({ active: true, step: "model" });
        session.saveSession();
        continue;
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
      if (!stripped) {
        console.log("Prompt is required for first run. Enter prompt text or type 'back'/'exit'.");
        continue;
      }
      if (stripped.startsWith("/")) {
        console.log(tui.yellow("At this step, enter the prompt as plain text (no leading /), or type back or exit."));
        continue;
      }
      const output = cmdPromptSet(session, raw);
      if (output) {
        console.log(output);
      }
      if (validatePromptValue(raw) !== null) {
        continue;
      }
      session.setSetupState({ active: true, step: "confirm" });
      session.saveSession();
      console.log(`Equivalent command: ${promptSetCommandText(session.config.prompt)}`);
      step = "confirm";
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
        const actionRaw = await readLineOrEof(holder.rl, "Choose action [run/back/exit]: ");
        if (actionRaw === null) {
          return null;
        }
        const action = actionRaw.trim().toLowerCase();
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
  const historyPath = session.historyPath;
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });

  const holder: RlHolder = {
    rl: readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    }),
  };

  console.log(tui.bold(`cursor-orch v${readVersion()}`));
  if (isInteractiveTty()) {
    console.log(
      tui.dim(
        "TTY line editor: Ctrl+J (or Alt+Enter) inserts a newline; Enter submits. Shift+Enter submits too in integrated terminals.",
      ),
    );
  }
  console.log(tui.dim("Plain text at > sets the orchestration prompt; lines starting with / are commands. Type /help for the list."));
  console.log(tui.dim("Next: complete guided setup (or set the prompt at > or via /prompt-set), then run /run."));
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
    const cfg = await runGuidedSetup(session, holder, historyPath);
    if (cfg) {
      holder.rl.close();
      return cfg;
    }
  }

  const useTtyEditor = isInteractiveTty();
  if (useTtyEditor) {
    holder.rl.close();
    process.stdin.resume();
  }

  const readMainLine = (): Promise<string | null> =>
    useTtyEditor ? readReplLineTTY(historyPath) : readLineOrEof(holder.rl, "> ");

  try {
    while (true) {
      const rawLine = await readMainLine();
      if (rawLine === null) {
        return null;
      }
      const text = rawLine.trim();
      if (!text) {
        continue;
      }
      if (text.startsWith("/") && rawLine.includes("\n")) {
        console.log(
          tui.yellow(
            "Slash commands must be on one line. Use one line for /commands, or enter a multi-line prompt without a leading /.",
          ),
        );
        continue;
      }
      if (!text.startsWith("/")) {
        const output = cmdPromptSet(session, rawLine);
        if (output) {
          console.log(output);
        }
        if (validatePromptValue(rawLine) === null) {
          session.saveSession();
        }
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
    if (!useTtyEditor) {
      holder.rl.close();
    }
  }
}
