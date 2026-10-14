/**
 * The `ukb` tool's prompt copy. Pi injects it into every system prompt, so it is
 * the only place the board's rules are guaranteed to be in front of the model —
 * a skill body is loaded on demand. The module lives in packages/pi; see
 * pi-overlay-render.test.ts for why this suite exercises it.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMPT_GUIDELINES,
  DEFAULT_PROMPT_SNIPPET,
  resolveGuidance,
} from "../../pi/extensions/using-kanban/guidance.js";

describe("DEFAULT_PROMPT_GUIDELINES", () => {
  it("is a substantial list of non-empty sentences", () => {
    expect(DEFAULT_PROMPT_GUIDELINES.length).toBeGreaterThanOrEqual(8);
    for (const guideline of DEFAULT_PROMPT_GUIDELINES) {
      expect(guideline.trim().length).toBeGreaterThan(20);
    }
  });

  it("carries no literal numbering — Pi adds the bullets", () => {
    for (const guideline of DEFAULT_PROMPT_GUIDELINES) {
      expect(guideline).not.toMatch(/^\s*\d+[.)]\s/);
    }
  });

  it("states the rules that exist nowhere else", () => {
    const all = DEFAULT_PROMPT_GUIDELINES.join("\n");
    // The load-bearing one: the overlay draws this column on screen.
    expect(all).toContain("exactly one card in `doing`");
    // ...and the rest of the hard rules, which otherwise live only in SKILL.md.
    expect(all).toContain("claim");
    expect(all).toContain("claim_conflict");
    expect(all).toContain("body");
    expect(all).toContain("invalid_state");
    expect(all).toContain("forbidden");
    expect(all).toContain("note");
    expect(all).toContain("delete");
    expect(all).toContain("trivial");
  });
});

describe("resolveGuidance", () => {
  it("returns the built-ins when nothing is configured", () => {
    const guidance = resolveGuidance({});
    expect(guidance.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
    expect(guidance.promptGuidelines).toEqual(DEFAULT_PROMPT_GUIDELINES);
  });

  it("overrides the snippet alone, keeping the default rules", () => {
    const guidance = resolveGuidance({
      guidance: { promptSnippet: "Custom" },
    });
    expect(guidance.promptSnippet).toBe("Custom");
    expect(guidance.promptGuidelines).toEqual(DEFAULT_PROMPT_GUIDELINES);
  });

  it("overrides the rules alone, keeping the default snippet", () => {
    const guidance = resolveGuidance({
      guidance: { promptGuidelines: ["Only this"] },
    });
    expect(guidance.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
    expect(guidance.promptGuidelines).toEqual(["Only this"]);
  });

  it("overrides both", () => {
    const guidance = resolveGuidance({
      guidance: { promptSnippet: "S", promptGuidelines: ["A", "B"] },
    });
    expect(guidance).toEqual({
      promptSnippet: "S",
      promptGuidelines: ["A", "B"],
    });
  });
});
