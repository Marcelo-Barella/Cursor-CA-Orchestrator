import { describe, expect, it } from "vitest";
import {
  bufferEditLines,
  cursorEditRowAndCol,
  encodeHistoryEntry,
  extractSlashQueryPrefix,
  parseHistoryFileText,
  parseKeysChunk,
  shouldShowSlashSuggestions,
} from "../src/lib/repl/tty-line-editor.js";

describe("tty-line-editor slash gate", () => {
  it("shows suggestions for slash only or slash plus spaces before cursor", () => {
    expect(shouldShowSlashSuggestions("/", 1)).toBe(true);
    expect(shouldShowSlashSuggestions("  /   ", 6)).toBe(true);
  });

  it("hides after a space inside the command segment", () => {
    expect(shouldShowSlashSuggestions("/repo ", 6)).toBe(false);
  });

  it("extracts prefix for filtering", () => {
    expect(extractSlashQueryPrefix("/pro", 4)).toBe("pro");
    expect(extractSlashQueryPrefix("/  pro", 6)).toBe("pro");
  });
});

describe("parseKeysChunk", () => {
  it("maps Ctrl+D (0x04) to eot", () => {
    const { keys } = parseKeysChunk(Buffer.alloc(0), Buffer.from([0x04]));
    expect(keys).toEqual([{ kind: "eot" }]);
  });
});

describe("parseKeysChunk CR/LF/CRLF/paste", () => {
  it("CR (0x0d) produces enter", () => {
    const { keys } = parseKeysChunk(Buffer.alloc(0), Buffer.from([0x0d]));
    expect(keys).toEqual([{ kind: "enter" }]);
  });

  it("LF (0x0a) produces newline", () => {
    const { keys } = parseKeysChunk(Buffer.alloc(0), Buffer.from([0x0a]));
    expect(keys).toEqual([{ kind: "newline" }]);
  });

  it("CRLF (0x0d 0x0a) produces single enter", () => {
    const { keys } = parseKeysChunk(Buffer.alloc(0), Buffer.from([0x0d, 0x0a]));
    expect(keys).toEqual([{ kind: "enter" }]);
  });

  it("CRLF between chars produces single enter between chars", () => {
    const { keys } = parseKeysChunk(Buffer.alloc(0), Buffer.from("a\r\nb"));
    expect(keys).toEqual([
      { kind: "char", value: "a" },
      { kind: "enter" },
      { kind: "char", value: "b" },
    ]);
  });

  it("bracketed paste with embedded LF produces char keys only, no enter or newline", () => {
    const { keys } = parseKeysChunk(
      Buffer.alloc(0),
      Buffer.from("\x1b[200~hello\nworld\x1b[201~"),
    );
    expect(keys).toEqual([
      { kind: "char", value: "h" },
      { kind: "char", value: "e" },
      { kind: "char", value: "l" },
      { kind: "char", value: "l" },
      { kind: "char", value: "o" },
      { kind: "char", value: "\n" },
      { kind: "char", value: "w" },
      { kind: "char", value: "o" },
      { kind: "char", value: "r" },
      { kind: "char", value: "l" },
      { kind: "char", value: "d" },
    ]);
    expect(keys.some((k) => k.kind === "enter" || k.kind === "newline")).toBe(false);
  });

  it("bracketed paste CRLF produces single newline char, no enter", () => {
    const { keys } = parseKeysChunk(
      Buffer.alloc(0),
      Buffer.from("\x1b[200~line1\r\nline2\x1b[201~"),
    );
    const values = keys
      .filter((k): k is { kind: "char"; value: string } => k.kind === "char")
      .map((k) => k.value)
      .join("");
    expect(values).toBe("line1\nline2");
    expect(keys.some((k) => k.kind === "enter" || k.kind === "newline")).toBe(false);
  });

  it("bracketed paste with trailing CR after end returns chars and no enter", () => {
    const { keys } = parseKeysChunk(
      Buffer.alloc(0),
      Buffer.from("\x1b[200~abc\x1b[201~\r"),
    );
    const charKeys = keys.filter((k) => k.kind === "char");
    const enterKeys = keys.filter((k) => k.kind === "enter");
    expect(charKeys).toEqual([
      { kind: "char", value: "a" },
      { kind: "char", value: "b" },
      { kind: "char", value: "c" },
    ]);
    expect(enterKeys).toEqual([{ kind: "enter" }]);
  });

  it("CSI u Enter with shift (13;1) is newline", () => {
    const { keys } = parseKeysChunk(Buffer.alloc(0), Buffer.from("\x1b[13;1u"));
    expect(keys).toEqual([{ kind: "newline" }]);
  });

  it("CSI u Enter plain (13) is enter", () => {
    const { keys } = parseKeysChunk(Buffer.alloc(0), Buffer.from("\x1b[13u"));
    expect(keys).toEqual([{ kind: "enter" }]);
  });

  it("CSI u Enter with ctrl (13;4) is enter", () => {
    const { keys } = parseKeysChunk(Buffer.alloc(0), Buffer.from("\x1b[13;4u"));
    expect(keys).toEqual([{ kind: "enter" }]);
  });

  it("xterm modifyOtherKeys Shift+Enter (27;13;1~) is newline", () => {
    const { keys } = parseKeysChunk(Buffer.alloc(0), Buffer.from("\x1b[27;13;1~"));
    expect(keys).toEqual([{ kind: "newline" }]);
  });

  it("xterm modifyOtherKeys Ctrl+Enter (27;13;4~) is enter", () => {
    const { keys } = parseKeysChunk(Buffer.alloc(0), Buffer.from("\x1b[27;13;4~"));
    expect(keys).toEqual([{ kind: "enter" }]);
  });

  it("xterm.js Alt+Enter (ESC CR) is newline", () => {
    const { keys } = parseKeysChunk(Buffer.alloc(0), Buffer.from("\x1b\x0d"));
    expect(keys).toEqual([{ kind: "newline" }]);
  });
});

describe("history file encoding", () => {
  it("round-trips multiline entries via JSON lines", () => {
    const a = "line1\nline2";
    const b = "single";
    const file = `${encodeHistoryEntry(a)}\n${encodeHistoryEntry(b)}\n`;
    expect(parseHistoryFileText(file)).toEqual([a, b]);
  });

  it("keeps last 500 decoded entries", () => {
    const lines = Array.from({ length: 502 }, (_, i) => encodeHistoryEntry(`x${i}`));
    const file = `${lines.join("\n")}\n`;
    const got = parseHistoryFileText(file);
    expect(got).toHaveLength(500);
    expect(got[0]).toBe("x2");
    expect(got[499]).toBe("x501");
  });

  it("falls back to legacy plain lines when not JSON string", () => {
    expect(parseHistoryFileText("plain one\n")).toEqual(["plain one"]);
  });
});

describe("multiline prompt layout helpers", () => {
  it("splits buffer into lines for display rows", () => {
    expect(bufferEditLines("a\nb")).toEqual(["a", "b"]);
    expect(bufferEditLines("")).toEqual([""]);
  });

  it("maps cursor to edit row and column with two-char prefix", () => {
    expect(cursorEditRowAndCol("a\nb", 0)).toEqual({ row: 0, col: 2 });
    expect(cursorEditRowAndCol("a\nb", 1)).toEqual({ row: 0, col: 3 });
    expect(cursorEditRowAndCol("a\nb", 2)).toEqual({ row: 1, col: 2 });
    expect(cursorEditRowAndCol("a\nb", 3)).toEqual({ row: 1, col: 3 });
  });
});
