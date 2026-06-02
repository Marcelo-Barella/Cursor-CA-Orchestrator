import { describe, expect, it } from "vitest";
import { padEnd, visibleWidth, wrapText } from "../src/tui/style.js";
import { tui } from "../src/tui/style.js";

describe("visibleWidth", () => {
  it("ignores ANSI escape sequences when measuring display width", () => {
    const styled = `${tui.green("ok")}!!`;
    expect(visibleWidth(styled)).toBe(4);
    expect(visibleWidth("plain")).toBe(5);
  });

  it("pads to target width using visible columns", () => {
    const cell = padEnd(tui.bold("ab"), 5);
    expect(visibleWidth(cell)).toBe(5);
  });
});

describe("wrapText", () => {
  it("splits long strings into fixed-width chunks", () => {
    expect(wrapText("abcdef", 4)).toEqual(["abcd", "ef"]);
  });
});
