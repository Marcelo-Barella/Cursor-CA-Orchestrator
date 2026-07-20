import { describe, expect, it } from "vitest";
import { normalizeWorkerPayload } from "../src/orchestrator.js";

const MAX_SUMMARY_BYTES = 4096;
const MAX_OUTPUTS_BYTES = 256 * 1024;

describe("normalizeWorkerPayload", () => {
  it("accepts completed payload and fills task_id and outputs defaults", () => {
    const out = normalizeWorkerPayload({ status: "completed", summary: "done" }, "t1");
    expect(out).toMatchObject({
      status: "completed",
      summary: "done",
      task_id: "t1",
      outputs: {},
    });
  });

  it("preserves an explicit task_id", () => {
    const out = normalizeWorkerPayload(
      { status: "failed", task_id: "other", summary: null, outputs: {} },
      "t1",
    );
    expect(out?.task_id).toBe("other");
  });

  it("accepts blocked and failed statuses", () => {
    expect(normalizeWorkerPayload({ status: "blocked", summary: null, outputs: {} }, "t1")?.status).toBe(
      "blocked",
    );
    expect(normalizeWorkerPayload({ status: "failed", summary: "err", outputs: {} }, "t1")?.status).toBe("failed");
  });

  it("rejects non-objects and non-canonical status strings", () => {
    expect(normalizeWorkerPayload(null, "t1")).toBeNull();
    expect(normalizeWorkerPayload([], "t1")).toBeNull();
    expect(normalizeWorkerPayload({ status: "finished" }, "t1")).toBeNull();
    expect(normalizeWorkerPayload({ status: "done" }, "t1")).toBeNull();
    expect(normalizeWorkerPayload({ status: "" }, "t1")).toBeNull();
  });

  it("rejects payloads that omit status (empty object or summary-only)", () => {
    expect(normalizeWorkerPayload({}, "t1")).toBeNull();
    expect(normalizeWorkerPayload({ summary: "looks done", outputs: {} }, "t1")).toBeNull();
  });

  it("coerces non-string summary to null", () => {
    const out = normalizeWorkerPayload({ status: "completed", summary: 42, outputs: {} }, "t1");
    expect(out?.summary).toBeNull();
  });

  it("replaces null or invalid outputs with an empty object", () => {
    const missing = normalizeWorkerPayload({ status: "completed", summary: "ok" }, "t1");
    expect(missing?.outputs).toEqual({});

    const invalid = normalizeWorkerPayload({ status: "completed", summary: "ok", outputs: "nope" }, "t1");
    expect(invalid?.outputs).toEqual({});
  });

  it("truncates oversized summary before persistence", () => {
    const summary = "a".repeat(5000);
    const out = normalizeWorkerPayload({ status: "completed", summary, outputs: {} }, "t1");
    expect(out?.summary).toContain("[TRUNCATED]");
    expect(Buffer.byteLength(out!.summary as string, "utf8")).toBeLessThanOrEqual(
      MAX_SUMMARY_BYTES + Buffer.byteLength("\n[TRUNCATED]", "utf8"),
    );
  });

  it("truncates oversized outputs and sets truncated", () => {
    const huge = "x".repeat(300_000);
    const out = normalizeWorkerPayload(
      { status: "completed", summary: "ok", outputs: { big: huge, small: "y" } },
      "t1",
    );
    expect(out?.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(out?.outputs), "utf8")).toBeLessThanOrEqual(MAX_OUTPUTS_BYTES);
    const outputs = out?.outputs as Record<string, unknown>;
    expect(String(outputs.big)).toContain("[TRUNCATED]");
    expect(outputs.small).toBe("y");
  });
});
