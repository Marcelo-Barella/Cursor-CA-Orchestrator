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

type FailOptions = FeedbackOptions & {
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

function fail(opts: FailOptions): never {
  renderFeedback(opts);
  process.exit(opts.exitCode);
}

function requireEnv(
  names: string[],
  opts: FailOptions,
  failFn: (opts: FailOptions) => never = fail,
): Record<string, string> {
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
    failFn({
      ...opts,
      what_happened: `${opts.what_happened} Missing or empty: ${missing.join(", ")}.`,
    });
  }
  return values;
}

function getEnv(
  name: string,
  failOpts: FailOptions,
  failFn: (opts: FailOptions) => never = fail,
): string {
  const value = process.env[name];
  if (value === undefined || !value.trim()) {
    const actual = value === undefined ? "missing" : "empty";
    failFn({
      ...failOpts,
      what_happened: `${failOpts.what_happened} ${name} is ${actual}.`,
    });
  }
  return value.trim();
}

export async function runCleanupCommand(
  opts: {
    olderThan: string;
    dryRun?: boolean;
  },
  deps: {
    finish?: (code: number) => never;
    repoStore?: RepoStoreClient;
  } = {},
): Promise<void> {
  const finish = deps.finish ?? ((code: number): never => process.exit(code));
  const failWithFinish = (failOpts: FailOptions): never => {
    renderFeedback(failOpts);
    return finish(failOpts.exitCode);
  };
  const env = requireEnv(
    ["GH_TOKEN"],
    {
      code: "CLEANUP-001",
      severity: "FATAL",
      title: "Missing GH_TOKEN",
      what_happened: "cleanup requires GitHub access.",
      next_step: "Set GH_TOKEN and rerun.",
      alternative: "Export GH_TOKEN inline.",
      example: "GH_TOKEN=... BOOTSTRAP_OWNER=owner BOOTSTRAP_REPO=repo cursor-orch cleanup",
      exitCode: 1,
    },
    failWithFinish,
  );
  const owner = getEnv(
    "BOOTSTRAP_OWNER",
    {
      code: "ENV-001",
      severity: "FATAL",
      title: "BOOTSTRAP_OWNER",
      what_happened: "cleanup requires BOOTSTRAP_OWNER.",
      next_step: "Set BOOTSTRAP_OWNER.",
      alternative: "Export inline.",
      example: "BOOTSTRAP_OWNER=owner BOOTSTRAP_REPO=repo cursor-orch cleanup",
      exitCode: 1,
    },
    failWithFinish,
  );
  const repo = getEnv(
    "BOOTSTRAP_REPO",
    {
      code: "ENV-001",
      severity: "FATAL",
      title: "BOOTSTRAP_REPO",
      what_happened: "cleanup requires BOOTSTRAP_REPO.",
      next_step: "Set BOOTSTRAP_REPO.",
      alternative: "Export inline.",
      example: "BOOTSTRAP_OWNER=owner BOOTSTRAP_REPO=repo cursor-orch cleanup",
      exitCode: 1,
    },
    failWithFinish,
  );
  let repoStore: RepoStoreClient;
  if (deps.repoStore) {
    repoStore = deps.repoStore;
  } else {
    repoStore = new RepoStoreClient(env.GH_TOKEN, owner, repo);
  }
  const branches = await repoStore.listRunBranches();
  if (!branches.length) {
    console.log("No run branches found.");
    return;
  }
  const days = parseInt(opts.olderThan, 10);
  if (!Number.isFinite(days) || days < 0) {
    fail({
      code: "CLEANUP-002",
      severity: "FATAL",
      title: "Invalid --older-than",
      what_happened: `cleanup received invalid --older-than value: ${opts.olderThan}.`,
      next_step: "Pass a non-negative integer number of days.",
      alternative: "Use --older-than 7.",
      example: "cursor-orch cleanup --older-than 7",
      exitCode: 1,
    });
  }
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const eligible: string[] = [];
  for (const branch of branches) {
    const runId = branch.replace(/^run\//, "");
    const commitDate = await repoStore.getRunBranchCommitDate(runId);
    if (commitDate && commitDate.getTime() < cutoffMs) {
      eligible.push(branch);
    }
  }
  if (opts.dryRun) {
    console.log(`Found ${eligible.length} run branch(es) older than ${days} day(s) (dry run - not deleting):`);
    for (const branch of eligible) {
      console.log(`  - ${branch}`);
    }
    return;
  }
  let deleted = 0;
  for (const branch of eligible) {
    const runId = branch.replace(/^run\//, "");
    await repoStore.deleteRunBranch(runId);
    console.log(`Deleted branch: ${branch}`);
    deleted += 1;
  }
  console.log(`Deleted ${deleted} run branch(es).`);
}
