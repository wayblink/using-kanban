/**
 * Terminal sanitizing for text that came from a card.
 *
 * A card's title, body, assignee, notes and even its actor name are written by
 * whoever ran `ukb add`/`edit`/`note` — any agent, and any human. That text is
 * then printed to a terminal by `ukb show`, `ukb board`, `ukb mine`, and (via
 * the Pi tool's stdout) inside an agent's UI. Untrusted input rendered into a
 * privileged surface is an escape-sequence problem, not a cosmetic one:
 *
 *   ESC[2J              clears the screen, so `ukb board` prints nothing
 *   ESC]0;x BEL         sets the terminal window title
 *   ESC]52;c;base64 BEL writes to the system clipboard
 *   \r                  overwrites the line just printed: a card can forge
 *                       another card's row in `ukb board`
 *   \n in a title       makes one card print as two rows
 *   U+202E              reverses how the rest of the line reads, so [done] can
 *                       be made to look like [todo]
 *
 * Sanitize on the way OUT, never on the way in: the event log keeps the true
 * text, `ukb board --json` and the Web UI keep the true text, and only the
 * terminal rendering is filtered. A caller that needs the original bytes has
 * the JSON door.
 */

/* eslint-disable no-control-regex -- matching control characters is exactly what
   this function is for; the rule guards against accidental ones. */
export function sanitizeTerminalText(value: string): string {
  return (
    value
      // CSI sequences, via both ESC-[ and the C1 single-byte introducer.
      .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
      // OSC sequences with their payload; an unterminated OSC swallows the
      // rest of the string, matching how a real terminal would treat it.
      .replace(
        /(?:\u001b\]|\u009d)[^\u0007\u009c\u001b]*(?:\u0007|\u009c|\u001b\\)?/g,
        "",
      )
      // Any remaining two-character ESC sequence.
      .replace(/\u001b./g, "")
      // Unicode line/paragraph separators join lines like \n does below.
      .replace(/[\u2028\u2029]/g, " ")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) =>
        character === "\n" || character === "\r" || character === "\t"
          ? " "
          : "",
      )
      // Bidi embedding/override/isolate controls and LRM/RLM marks.
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
  );
}
/* eslint-enable no-control-regex */

/**
 * A multi-line field — a card body — flattened to one sanitized line per
 * original line.
 *
 * Split BEFORE sanitizing on purpose: `sanitizeTerminalText` turns newlines
 * into spaces, so running it over a whole body would collapse the body into a
 * single line. Newlines are the caller's own structure; every other control
 * character in the field is not.
 */
export function sanitizeTerminalBlock(value: string): string[] {
  return value.split("\n").map(sanitizeTerminalText);
}
