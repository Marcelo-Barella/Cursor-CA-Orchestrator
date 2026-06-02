import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWorkerArtifactErrorRetryPlan } from "../src/orchestrator.js";

describe("readWorkerArtifactErrorRetryPlan", () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRIES;
    delete process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRY_MS;
  });

  afterEach(() => {
    process.env = env;
  });

  it("uses defaults when env vars are unset", () => {
    expect(readWorkerArtifactErrorRetryPlan()).toEqual({ maxRetries: 6, delayMs: 2000 });
  });

  it("honors valid overrides within bounds", () => {
    process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRIES = "3";
    process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRY_MS = "500";
    expect(readWorkerArtifactErrorRetryPlan()).toEqual({ maxRetries: 3, delayMs: 500 });
  });

  it("ignores out-of-range or non-numeric values", () => {
    process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRIES = "999";
    process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRY_MS = "not-a-number";
    expect(readWorkerArtifactErrorRetryPlan()).toEqual({ maxRetries: 6, delayMs: 2000 });
  });

  it("accepts zero retries and zero delay", () => {
    process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRIES = "0";
    process.env.CURSOR_ORCH_WORKER_ARTIFACT_ERROR_RETRY_MS = "0";
    expect(readWorkerArtifactErrorRetryPlan()).toEqual({ maxRetries: 0, delayMs: 0 });
  });
});
