import { describe, expect, it } from "vitest";
import {
  sanitizeTerminalBlock,
  sanitizeTerminalText,
} from "../src/sanitize.js";

describe("sanitizeTerminalText", () => {
  it("drops a CSI sequence whole, leaving no printable remnant", () => {
    expect(sanitizeTerminalText("evil\u001b[2Jtitle")).toBe("eviltitle");
    expect(sanitizeTerminalText("\u001b[31mred\u001b[0m")).toBe("red");
    // C1 single-byte introducer, not just ESC-[.
    expect(sanitizeTerminalText("a\u009b31mb")).toBe("ab");
  });

  it("drops OSC sequences, terminated and unterminated", () => {
    expect(sanitizeTerminalText("a\u001b]0;window title\u0007b")).toBe("ab");
    // an unterminated OSC swallows the rest, exactly as a terminal would
    expect(sanitizeTerminalText("a\u001b]52;c;cGF5bG9hZA==")).toBe("a");
    expect(sanitizeTerminalText("a\u001b]0;t\u001b\\b")).toBe("ab");
  });

  it("collapses newlines, carriage returns and tabs to spaces", () => {
    expect(sanitizeTerminalText("one\ntwo\tthree\rfour")).toBe(
      "one two three four",
    );
    expect(sanitizeTerminalText("line\u2028sep\u2029par")).toBe("line sep par");
  });

  it("removes bidi overrides, isolates and marks", () => {
    expect(sanitizeTerminalText("safe\u202ereversed")).toBe("safereversed");
    expect(sanitizeTerminalText("\u2066iso\u2069")).toBe("iso");
    expect(sanitizeTerminalText("a\u200eb\u200fc")).toBe("abc");
  });

  it("strips remaining C0/C1 controls and DEL", () => {
    expect(sanitizeTerminalText("a\u0000b\u0007c\u007fd\u0085e")).toBe("abcde");
    expect(sanitizeTerminalText("bell\u001b")).toBe("bell");
  });

  it("leaves legitimate text alone", () => {
    for (const value of [
      "Fix the flaky retry backoff test",
      "keep 🎯 emoji",
      "ünïcode and 中文 and عربى",
      "#3 [doing] — 20% *done*",
    ]) {
      expect(sanitizeTerminalText(value)).toBe(value);
    }
  });

  it("is idempotent", () => {
    const nasty = "a\u001b[2Jb\r\nc\u202ed\u200e";
    const once = sanitizeTerminalText(nasty);
    expect(sanitizeTerminalText(once)).toBe(once);
  });
});

describe("sanitizeTerminalBlock", () => {
  it("keeps the line structure while cleaning each line", () => {
    const body = "step one\nstep \u001b[31mtwo\u001b[0m\nstep\rthree";
    expect(sanitizeTerminalBlock(body)).toEqual([
      "step one",
      "step two",
      "step three",
    ]);
  });

  it("returns one entry per line, including empty ones", () => {
    expect(sanitizeTerminalBlock("a\n\nb")).toEqual(["a", "", "b"]);
    expect(sanitizeTerminalBlock("")).toEqual([""]);
  });
});
