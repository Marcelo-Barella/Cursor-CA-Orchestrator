export const PRECEDENCE_ORDER: readonly string[] = ["flag", "env", "project", "session", "default"];

export const FIELD_SOURCE_OF_TRUTH: Record<string, string> = {
  config_path: "flag (--config), env (CURSOR_ORCH_CONFIG), default file (.cursor-orch.yaml)",
  bootstrap_repo_name: "resolved runtime config input",
  name: "resolved runtime config input",
  model: "resolved runtime config input",
  prompt: "resolved runtime config input",
  "target.auto_create_pr": "resolved runtime config input",
  "target.branch_prefix": "resolved runtime config input",
  repositories: "project/session config payload",
  tasks: "project/session config payload",
  "secrets.CURSOR_API_KEY": "environment variable (CURSOR_API_KEY)",
  "secrets.GH_TOKEN": "environment variable (GH_TOKEN)",
  CURSOR_API_KEY: "environment variable (CURSOR_API_KEY)",
  GH_TOKEN: "environment variable (GH_TOKEN)",
  session: "session fallback file (~/.cursor-orch/session.yaml)",
};

export const FIELD_PRECEDENCE: Record<string, string> = {
  config_path: "flag > env > default-file",
  bootstrap_repo_name: "flag > env > project > session > default",
  name: "env > project > session > default",
  model: "env > project > session > default",
  prompt: "env > project > session > default",
  "target.auto_create_pr": "env > project > session > default",
  "target.branch_prefix": "env > project > session > default",
  repositories: "project > session > default",
  tasks: "project > session > default",
  "secrets.CURSOR_API_KEY": "env > unset",
  "secrets.GH_TOKEN": "env > unset",
  CURSOR_API_KEY: "env > unset",
  GH_TOKEN: "env > unset",
  session: "session-file > unset",
};
