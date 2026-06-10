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

  it("uses default 0 when env var is unset", () => {
    expect(readTaskFailureRetryCap()).toBe(0);
  });

  it("honors valid overrides within bounds", () => {
    process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES = "3";
    expect(readTaskFailureRetryCap()).toBe(3);
    process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES = "32";
    expect(readTaskFailureRetryCap()).toBe(32);
  });

  it("floors fractional values", () => {
    process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES = "2.9";
    expect(readTaskFailureRetryCap()).toBe(2);
  });

  it("ignores out-of-range or non-numeric values", () => {
    process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES = "33";
    expect(readTaskFailureRetryCap()).toBe(0);
    process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES = "-1";
    expect(readTaskFailureRetryCap()).toBe(0);
    process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES = "not-a-number";
    expect(readTaskFailureRetryCap()).toBe(0);
  });

  it("accepts zero retries explicitly", () => {
    process.env.CURSOR_ORCH_TASK_FAILURE_MAX_RETRIES = "0";
    expect(readTaskFailureRetryCap()).toBe(0);
  });
});
