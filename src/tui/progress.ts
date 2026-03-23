import { spinner } from "@crustjs/prompts";
import { tui } from "./style.js";

export function isQuietProgress(): boolean {
  const v = process.env.CURSOR_ORCH_QUIET;
  return v === "1" || v === "true";
}

export async function withOrchestratorLaunchProgress<T>(
  message: string,
  task: (updateMessage: (m: string) => void) => Promise<T>,
): Promise<T> {
  if (isQuietProgress()) {
    console.log(tui.dim(message));
    return task(() => {});
  }
  return spinner({
    message,
    spinner: "dots",
    task: async ({ updateMessage }) => task(updateMessage),
  });
}
