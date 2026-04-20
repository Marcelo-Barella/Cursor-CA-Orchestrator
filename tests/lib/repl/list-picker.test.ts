import { describe, expect, it } from "vitest";
import { pickFromList } from "../../../src/lib/repl/list-picker.js";

function makeReader(inputs: string[]): () => Promise<string | null> {
  let i = 0;
  return async () => (i < inputs.length ? (inputs[i++] ?? null) : null);
}

describe("pickFromList (non-TTY)", () => {
  it("single-select by index", async () => {
    const logs: string[] = [];
    const r = await pickFromList(["alpha", "beta", "gamma"], {
      title: "Pick a model",
      renderItem: (s) => s,
      filterText: (s) => s,
      isTTY: false,
      readLine: makeReader(["2"]),
      writeLine: (s) => logs.push(s),
    });
    expect(r).toEqual({ kind: "selected", value: "beta" });
    expect(logs.some((l) => l.includes("Pick a model"))).toBe(true);
  });

  it("single-select by exact name", async () => {
    const r = await pickFromList(["alpha", "beta"], {
      title: "Pick",
      renderItem: (s) => s,
      filterText: (s) => s,
      isTTY: false,
      readLine: makeReader(["alpha"]),
      writeLine: () => {},
    });
    expect(r).toEqual({ kind: "selected", value: "alpha" });
  });

  it("single-select blank returns cancelled", async () => {
    const r = await pickFromList(["alpha", "beta"], {
      title: "Pick",
      renderItem: (s) => s,
      filterText: (s) => s,
      isTTY: false,
      readLine: makeReader([""]),
      writeLine: () => {},
    });
    expect(r).toEqual({ kind: "cancelled" });
  });

  it("invalid input reprints and then accepts", async () => {
    const logs: string[] = [];
    const r = await pickFromList(["alpha", "beta"], {
      title: "Pick",
      renderItem: (s) => s,
      filterText: (s) => s,
      isTTY: false,
      readLine: makeReader(["nope", "1"]),
      writeLine: (s) => logs.push(s),
    });
    expect(r).toEqual({ kind: "selected", value: "alpha" });
    expect(logs.filter((l) => l.includes("Pick")).length).toBeGreaterThanOrEqual(2);
  });

  it("multi-select parses comma list", async () => {
    const r = await pickFromList(["a", "b", "c", "d"], {
      title: "Pick",
      renderItem: (s) => s,
      filterText: (s) => s,
      multiSelect: true,
      isTTY: false,
      readLine: makeReader(["1,3"]),
      writeLine: () => {},
    });
    expect(r).toEqual({ kind: "selected", values: ["a", "c"] });
  });

  it("multi-select parses whitespace list preserving order", async () => {
    const r = await pickFromList(["a", "b", "c", "d"], {
      title: "Pick",
      renderItem: (s) => s,
      filterText: (s) => s,
      multiSelect: true,
      isTTY: false,
      readLine: makeReader(["3 1"]),
      writeLine: () => {},
    });
    expect(r).toEqual({ kind: "selected", values: ["c", "a"] });
  });

  it("multi-select blank cancels", async () => {
    const r = await pickFromList(["a", "b"], {
      title: "Pick",
      renderItem: (s) => s,
      filterText: (s) => s,
      multiSelect: true,
      isTTY: false,
      readLine: makeReader([""]),
      writeLine: () => {},
    });
    expect(r).toEqual({ kind: "cancelled" });
  });

  it("multi-select invalid reprompts", async () => {
    const logs: string[] = [];
    const r = await pickFromList(["a", "b"], {
      title: "Pick",
      renderItem: (s) => s,
      filterText: (s) => s,
      multiSelect: true,
      isTTY: false,
      readLine: makeReader(["zzz", "1,2"]),
      writeLine: (s) => logs.push(s),
    });
    expect(r).toEqual({ kind: "selected", values: ["a", "b"] });
    expect(logs.filter((l) => l.includes("Pick")).length).toBeGreaterThanOrEqual(2);
  });

  it("empty items list returns cancelled with message", async () => {
    const logs: string[] = [];
    const r = await pickFromList<string>([], {
      title: "Pick",
      renderItem: (s) => s,
      filterText: (s) => s,
      isTTY: false,
      readLine: makeReader([]),
      writeLine: (s) => logs.push(s),
    });
    expect(r).toEqual({ kind: "cancelled" });
    expect(logs.some((l) => l.includes("No items available"))).toBe(true);
  });

  it("EOF on read returns cancelled", async () => {
    const r = await pickFromList(["a"], {
      title: "Pick",
      renderItem: (s) => s,
      filterText: (s) => s,
      isTTY: false,
      readLine: async () => null,
      writeLine: () => {},
    });
    expect(r).toEqual({ kind: "cancelled" });
  });
});
