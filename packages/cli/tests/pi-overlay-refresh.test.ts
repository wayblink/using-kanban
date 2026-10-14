/**
 * The overlay's pure modules live in packages/pi, but that package declares no
 * dependencies on purpose: Pi supplies its host modules at runtime, and any
 * devDependency there makes pnpm auto-install those peers — a second copy of
 * pi-tui/typebox in the workspace. The modules are deliberately Pi-free (that
 * is why they are unit-testable at all), so they are exercised from this suite,
 * which already reads the packages/pi tree (see init.test.ts).
 */
import { describe, expect, it } from "vitest";
import { shouldRefreshAfterCommand } from "../../pi/extensions/using-kanban/overlay-refresh.js";

describe("shouldRefreshAfterCommand", () => {
  it("repaints after a mutation", () => {
    // These are the verbs a human actually types, and the ones whose absence
    // from this list produced a panel that looked broken.
    for (const verb of [
      "done",
      "claim",
      "review",
      "add",
      "edit",
      "move",
      "reopen",
      "delete",
      "block",
      "unblock",
      "relate",
      "unrelate",
      "note",
      "note-edit",
      "note-remove",
    ]) {
      expect(shouldRefreshAfterCommand([verb, "1"], 0), verb).toBe(true);
    }
  });

  it("skips reads, which cannot have changed a card", () => {
    for (const verb of ["mine", "list", "board", "show", "help"]) {
      expect(shouldRefreshAfterCommand([verb], 0), verb).toBe(false);
      expect(shouldRefreshAfterCommand([verb, "319"], 0), verb).toBe(false);
    }
  });

  it("skips a failed command — it changed nothing", () => {
    expect(shouldRefreshAfterCommand(["done", "319"], 2)).toBe(false);
    expect(shouldRefreshAfterCommand(["bogus"], 1)).toBe(false);
  });

  it("treats an unknown verb as a mutation, not as a read", () => {
    // The denylist is the point: a verb added later repaints by default rather
    // than silently leaving the panel stale.
    expect(shouldRefreshAfterCommand(["archive", "319"], 0)).toBe(true);
  });

  it("treats no verb as the default read", () => {
    expect(shouldRefreshAfterCommand([], 0)).toBe(false);
  });

  it("ignores flags when deciding, since the verb leads", () => {
    expect(shouldRefreshAfterCommand(["board", "--project", "web"], 0)).toBe(
      false,
    );
    expect(shouldRefreshAfterCommand(["done", "--agent", "pi"], 0)).toBe(true);
  });
});
