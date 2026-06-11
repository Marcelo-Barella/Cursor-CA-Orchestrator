import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTaskFailureRetryCap } from "../src/orchestrator.js";

describe("readTaskFailureRetryCap", () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES;
  });

  afterEach(() => {
    process.env = env;
  });

  it("defaults to zero when env var is unset", () => {
    expect(readTaskFailureRetryCap()).toBe(0);
  });

  it("honors valid overrides within bounds", () => {
    process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES = "3";
    expect(readTaskFailureRetryCap()).toBe(3);
  });

  it("accepts the configured cap", () => {
    process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES = "32";
    expect(readTaskFailureRetryCap()).toBe(32);
  });

  it("ignores out-of-range or non-numeric values", () => {
    process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES = "99";
    expect(readTaskFailureRetryCap()).toBe(0);
    process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES = "not-a-number";
    expect(readTaskFailureRetryCap()).toBe(0);
  });
});
