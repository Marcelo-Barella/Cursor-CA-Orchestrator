export type {
  BranchLayout,
  ConfigResolution,
  DiagnosticFinding,
  OrchestratorConfig,
  RepoConfig,
  ResolvedValue,
  SourceType,
  TargetConfig,
  TaskConfig,
} from "./types.js";
export { FIELD_PRECEDENCE, FIELD_SOURCE_OF_TRUTH, PRECEDENCE_ORDER } from "./constants.js";
export { parseConfig, toYaml } from "./parse.js";
export { validateConfig, validateRepoRefs } from "./validate.js";
export { canonicalizeOrchestratorConfig } from "./canonicalize.js";
export { resolveConfigPrecedence } from "./resolve.js";
export { precedenceForField, resolutionToJson, sourceOfTruthForField } from "./resolution-json.js";
