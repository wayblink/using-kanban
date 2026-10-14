/**
 * Two sanitizers exist on purpose, and this is the guard that keeps them one
 * behaviour.
 *
 * The canonical implementation is `packages/core/src/sanitize.ts`, used by the
 * CLI's renderer. The Pi overlay needs the same thing, but sharing it would mean
 * a subpath export on core plus a `@wayblink/using-kanban-core` dependency on
 * `packages/pi` — and any dependency there makes pnpm resolve that package's
 * host-provided peers, committing a lockfile that installs a second copy of
 * pi-tui/typebox in CI. That is a lot of blast radius for twenty lines, so the
 * overlay keeps a copy and this test fails the moment the two disagree.
 *
 * Compares against the core *package* (resolves to `packages/core/dist`), i.e.
 * what the CLI actually runs. The root `test` script builds before testing.
 */
import { describe, expect, it } from "vitest";
import { sanitizeTerminalText as coreSanitize } from "@wayblink/using-kanban-core";
import { sanitizeTerminalText as overlaySanitize } from "../../pi/extensions/using-kanban/overlay-render.js";

const CORPUS: readonly string[] = [
  "",
  "plain title",
  "keep 🎯 emoji and 中文 and عربى",
  "a\u001b[2Jb",
  "\u001b[31mred\u001b[0m",
  "a\u009b31mb",
  "a\u001b]0;window title\u0007b",
  "a\u001b]52;c;cGF5bG9hZA==",
  "a\u001b]0;t\u001b\\b",
  "one\ntwo\tthree\rfour",
  "line\u2028sep\u2029par",
  "safe\u202ereversed",
  "\u2066iso\u2069",
  "a\u200eb\u200fc",
  "a\u0000b\u0007c\u007fd\u0085e",
  "bell\u001b",
  "#3 [doing] — 20% *done*",
  "a\n  #1 [done] impostor",
];

describe("the overlay's sanitizer", () => {
  it("agrees with core's, byte for byte, across a nasty corpus", () => {
    for (const value of CORPUS) {
      expect(overlaySanitize(value)).toBe(coreSanitize(value));
    }
  });
});
