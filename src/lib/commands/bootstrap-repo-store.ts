import { RepoStoreClient } from "../../api/repo-store.js";

type FeedbackOptions = {
  code: string;
  severity: string;
  title: string;
  what_happened: string;
  next_step: string;
  alternative: string;
  example: string;
};

export type FailOptions = FeedbackOptions & {
  exitCode: number;
};

function renderFeedback(opts: FeedbackOptions): void {
  console.log(
    [
      `[${opts.severity}] ${opts.code} ${opts.title}`,
      `What happened: ${opts.what_happened}`,
      `Next step: ${opts.next_step}`,
      `Non-interactive alternative: ${opts.alternative}`,
      `Example: ${opts.example}`,
    ].join("\n"),
  );
}

export function cliFail(opts: FailOptions): never {
  renderFeedback(opts);
  process.exit(opts.exitCode);
}

export function cliRequireEnv(names: string[], opts: FailOptions): Record<string, string> {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || !raw.trim()) {
      missing.push(name);
    } else {
      values[name] = raw.trim();
    }
  }
  if (missing.length) {
    cliFail({
      ...opts,
      what_happened: `${opts.what_happened} Missing or empty: ${missing.join(", ")}.`,
    });
  }
  return values;
}

export function cliGetEnv(name: string, failOpts: FailOptions): string {
  const value = process.env[name];
  if (value === undefined || !value.trim()) {
    const actual = value === undefined ? "missing" : "empty";
    cliFail({
      ...failOpts,
      what_happened: `${failOpts.what_happened} ${name} is ${actual}.`,
    });
  }
  return value.trim();
}

export function createBootstrapRepoStore(ghToken: string): RepoStoreClient {
  const owner = cliGetEnv("BOOTSTRAP_OWNER", {
    code: "ENV-001",
    severity: "FATAL",
    title: "Invalid BOOTSTRAP_OWNER",
    what_happened: "Command requires BOOTSTRAP_OWNER.",
    next_step: "Set BOOTSTRAP_OWNER.",
    alternative: "Export inline.",
    example: "BOOTSTRAP_OWNER=owner BOOTSTRAP_REPO=repo cursor-orch status --run <id>",
    exitCode: 1,
  });
  const repo = cliGetEnv("BOOTSTRAP_REPO", {
    code: "ENV-001",
    severity: "FATAL",
    title: "Invalid BOOTSTRAP_REPO",
    what_happened: "Command requires BOOTSTRAP_REPO.",
    next_step: "Set BOOTSTRAP_REPO.",
    alternative: "Export inline.",
    example: "BOOTSTRAP_OWNER=owner BOOTSTRAP_REPO=repo cursor-orch status --run <id>",
    exitCode: 1,
  });
  return new RepoStoreClient(ghToken, owner, repo);
}

export function bootstrapEnvIssues(): string | null {
  const names = ["GH_TOKEN", "BOOTSTRAP_OWNER", "BOOTSTRAP_REPO"] as const;
  const missing = names.filter((n) => {
    const v = process.env[n];
    return v === undefined || !String(v).trim();
  });
  if (!missing.length) {
    return null;
  }
  return `Missing or empty environment variables (${missing.join(", ")}). Set them in .env or export before running (same as status): GH_TOKEN, BOOTSTRAP_OWNER, BOOTSTRAP_REPO.`;
}

export function createBootstrapRepoStoreLoose(): RepoStoreClient | null {
  if (bootstrapEnvIssues() !== null) {
    return null;
  }
  return new RepoStoreClient(
    process.env.GH_TOKEN!.trim(),
    process.env.BOOTSTRAP_OWNER!.trim(),
    process.env.BOOTSTRAP_REPO!.trim(),
  );
}
