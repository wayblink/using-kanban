import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CARD_PRIORITIES,
  CARD_STATES,
  KanbanError,
  describeMutation,
  openKanban,
  type Actor,
  type Card,
  type Kanban,
} from "@wayblink/using-kanban-core";
import { z } from "zod";

/**
 * The optional `project` argument shared by every tool that can filter or set
 * it. Rejected slugs become tool errors with a readable message rather than a
 * zod stack trace, so agents can self-correct.
 */
function projectSchemaOptional() {
  return z
    .string()
    .optional()
    .describe(
      'Project slug, lowercase (e.g. "web", "api-core"). By convention this is the code repository name; use subproject for a direction inside it. Omit to include every project.',
    );
}

/**
 * The optional `subproject` argument on tools that filter or set it.
 *
 * Same slug rules as a project, and only meaningful under one — the core
 * refuses a direction without a repository, so this stays a plain optional
 * string rather than a second validation layer.
 */
function subprojectSchemaOptional() {
  return z
    .string()
    .optional()
    .describe(
      'Direction inside the project, lowercase (e.g. "auth", "roadmap"). Requires project. Omit to include every direction.',
    );
}

/**
 * The optional `priority` argument on add/edit.
 *
 * An enum rather than a free string: a typo becomes a readable tool error
 * instead of a card silently created at `normal`.
 */
function prioritySchemaOptional() {
  return z
    .enum(CARD_PRIORITIES)
    .optional()
    .describe(
      'How urgently the card wants attention: "high", "normal" (default) or "low" (minor, still wanted). Lower priorities sort after higher ones. "Not now" is not a priority — park a card with kanban_move to "someday" (assignee and reviewer are cleared).',
    );
}
import {
  formatBoard,
  formatCard,
  formatCardBrief,
  formatCards,
  formatProjects,
} from "./format.js";
import type { ResolvedMcpOptions } from "./options.js";

const MINE_DESCRIPTION = [
  "List YOUR open cards (todo/doing/review assigned to you).",
  "Call this at the start of every turn to find your work — it is a call to act, not a status report.",
  "For each card: call kanban_show to read its body (target files + acceptance criteria), kanban_claim any",
  "todo card BEFORE starting work on it, do the work, then kanban_review (or kanban_done if you are the",
  "reviewer). Never work an unclaimed card. Never stop at listing or summarizing — work the cards.",
].join(" ");

const cardIdSchema = z.number().int().positive().describe("Card id");

export function createMcpServer(options: ResolvedMcpOptions): McpServer {
  const actor: Actor = options.actor;

  /**
   * The store is opened on demand rather than at startup, because whether it
   * may be created depends on the tool being called: a read in a directory
   * with no board must fail loudly instead of silently reporting an empty
   * board, while a write is what brings the board into existence.
   *
   * Once opened it is cached — the server is long-lived and every tool after
   * the first shares one handle.
   */
  let opened: Kanban | undefined;
  const kanbanFor = (create: boolean): Kanban => {
    if (opened) return opened;
    opened = openKanban({ dir: options.dir, storage: options.storage, create });
    return opened;
  };
  /** Read-only tools: never create the store. */
  const read = (): Kanban => kanbanFor(false);
  /** Mutating tools: the store is created if this is the first card ever. */
  const write = (): Kanban => kanbanFor(true);

  const server = new McpServer(
    { name: "using-kanban", version: "0.1.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        "Shared kanban board for you and the human. Your identity is " +
        `${actor.type}/${actor.name}. ` +
        "Start each turn with kanban_my_cards; claim todo cards before working them; move to review when ready.",
    },
  );

  /* ------------------------------- queries ------------------------------ */

  server.registerTool(
    "kanban_board",
    {
      title: "Show board",
      description:
        "Show the board (todo/doing/review/done). Pass project to see just that project's cards.",
      inputSchema: {
        project: projectSchemaOptional(),
        subproject: subprojectSchemaOptional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(({ project, subproject }) => {
      const kanban = read();
      // Full index: a project slice must still count children in other
      // projects, or an umbrella's `▸done/total` would undercount.
      return text(
        formatBoard(
          kanban.board(project, subproject),
          new Map(kanban.cards().map((card) => [card.id, card])),
        ),
      );
    }),
  );

  server.registerTool(
    "kanban_my_cards",
    {
      title: "My open cards",
      description: MINE_DESCRIPTION,
      inputSchema: {
        project: projectSchemaOptional(),
        subproject: subprojectSchemaOptional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(({ project, subproject }) =>
      text(
        formatCards(
          read().mine(actor.name, project, subproject),
          "No open cards assigned to you.",
        ),
      ),
    ),
  );

  server.registerTool(
    "kanban_review_queue",
    {
      title: "My review queue",
      description:
        "Cards in review where you are the reviewer. Review each one, then kanban_done it or kanban_reopen it with feedback.",
      inputSchema: {
        agent: z
          .string()
          .optional()
          .describe("Actor name to check (defaults to you)"),
        project: projectSchemaOptional(),
        subproject: subprojectSchemaOptional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(({ agent, project, subproject }) => {
      const name = agent ?? actor.name;
      const cards = read().reviewQueue(name, project, subproject);
      return text(formatCards(cards, `Nothing waiting for ${name} to review.`));
    }),
  );

  server.registerTool(
    "kanban_projects",
    {
      title: "List projects",
      description:
        "Every project on this board with its card counts. Call this before filtering by project so you use a name that exists.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(() => {
      const summaries = read().projectSummary();
      return text(formatProjects(summaries));
    }),
  );

  server.registerTool(
    "kanban_show",
    {
      title: "Show card",
      description:
        "Read a card's full detail: body (target files and acceptance criteria), assignee, reviewer, upstream/downstream relations, parent and children, notes (document links) and event history. Always read the body before acting on a card.",
      inputSchema: { id: cardIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(({ id }) => {
      const kanban = read();
      const card = requireCard(kanban.card(id), id);
      return text(
        formatCard(card, kanban.history(id), {
          parent: card.parent === null ? null : kanban.card(card.parent),
          children: kanban.childrenOf(id),
        }),
      );
    }),
  );

  /* ------------------------------ mutations ----------------------------- */

  server.registerTool(
    "kanban_add",
    {
      title: "Add card",
      description:
        "Create a card in todo. Write actionable cards: put the target files/paths and acceptance criteria in body — a notification only carries the title, so without a body the assignee cannot tell what to do.",
      inputSchema: {
        title: z.string().min(1).describe("Short, imperative title"),
        body: z
          .string()
          .optional()
          .describe("Target files, acceptance criteria, context"),
        assignee: z
          .string()
          .optional()
          .describe("Actor name to assign (e.g. claude-code, or a human name)"),
        reviewer: z
          .string()
          .optional()
          .describe("Actor name expected to review"),
        blockedBy: z
          .array(z.number().int().positive())
          .optional()
          .describe("Card ids this card waits on"),
        project: projectSchemaOptional(),
        subproject: subprojectSchemaOptional(),
        priority: prioritySchemaOptional(),
      },
    },
    safe((input) => {
      const { card } = write().add(
        {
          title: input.title,
          body: input.body,
          assignee: input.assignee,
          reviewer: input.reviewer,
          blockedBy: input.blockedBy,
          project: input.project === "" ? null : input.project,
          subproject: input.subproject === "" ? null : input.subproject,
        },
        actor,
        "mcp",
      );
      return text(`created ${formatCardBrief(card)}`);
    }),
  );

  server.registerTool(
    "kanban_edit",
    {
      title: "Edit card",
      description:
        "Edit a card. Creator or assignee only. Pass an empty string to clear body/assignee/reviewer.",
      inputSchema: {
        id: cardIdSchema,
        title: z.string().optional(),
        body: z.string().optional(),
        assignee: z.string().optional(),
        reviewer: z.string().optional(),
        project: projectSchemaOptional(),
        subproject: subprojectSchemaOptional(),
        priority: prioritySchemaOptional(),
      },
    },
    safe((input) => {
      const { card } = write().edit(
        input.id,
        {
          title: input.title,
          body: input.body,
          assignee: input.assignee,
          reviewer: input.reviewer,
          project: input.project === "" ? null : input.project,
          subproject: input.subproject === "" ? null : input.subproject,
          priority: input.priority,
        },
        actor,
        "mcp",
      );
      return text(`updated ${formatCardBrief(card)}`);
    }),
  );

  server.registerTool(
    "kanban_claim",
    {
      title: "Claim card",
      description: [
        "Claim a todo card: moves it to doing and assigns it to you.",
        "ALWAYS claim before starting work on a card so teammates see it is in progress.",
        "Fails with claim_conflict when someone else already claimed it — pick another card or report the blocker.",
      ].join(" "),
      inputSchema: { id: cardIdSchema },
    },
    safe(({ id }) => {
      const result = write().claim(id, actor, "mcp");
      return text(
        describeMutation(formatCardBrief(result.card), result, "claimed"),
      );
    }),
  );

  server.registerTool(
    "kanban_review",
    {
      title: "Request review",
      description:
        "Move a card to review when your work is ready for its reviewer. Read the body first so you finish what the card actually asks for.",
      inputSchema: { id: cardIdSchema },
    },
    safe(({ id }) => {
      const result = write().review(id, actor, "mcp");
      return text(
        describeMutation(
          formatCardBrief(result.card),
          result,
          "moved to review",
        ),
      );
    }),
  );

  server.registerTool(
    "kanban_done",
    {
      title: "Mark done",
      description:
        "Mark a card done (idempotent). As the reviewer, use this to approve work you have actually reviewed.",
      inputSchema: { id: cardIdSchema },
    },
    safe(({ id }) => {
      const result = write().done(id, actor, "mcp");
      return text(
        describeMutation(formatCardBrief(result.card), result, "done"),
      );
    }),
  );

  server.registerTool(
    "kanban_reopen",
    {
      title: "Reopen card",
      description: "Send a card back to todo for rework.",
      inputSchema: { id: cardIdSchema },
    },
    safe(({ id }) => {
      const result = write().reopen(id, actor, "mcp");
      return text(
        describeMutation(formatCardBrief(result.card), result, "reopened"),
      );
    }),
  );

  server.registerTool(
    "kanban_move",
    {
      title: "Move card",
      description:
        'Move a card to any column. "someday" parks it for later: it leaves the to-do list and its assignee/reviewer are cleared. Prefer the intent verbs (kanban_claim / kanban_review / kanban_done / kanban_reopen) when they fit.',
      inputSchema: {
        id: cardIdSchema,
        to: z.enum(CARD_STATES),
      },
    },
    safe(({ id, to }) => {
      const result = write().move(id, to, actor, "mcp");
      return text(
        describeMutation(
          formatCardBrief(result.card),
          result,
          `moved to ${to}`,
        ),
      );
    }),
  );

  server.registerTool(
    "kanban_delete",
    {
      title: "Delete card",
      description: "Permanently delete a card. Creator only.",
      inputSchema: { id: cardIdSchema },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    safe(({ id }) => {
      write().remove(id, actor, "mcp");
      return text(`deleted #${id}`);
    }),
  );

  server.registerTool(
    "kanban_block",
    {
      title: "Block card",
      description:
        "Make card `id` wait on card `blockedBy` — the upstream spelling of a relation. Prefer kanban_relate when you want to name the direction. Cycles and self-blocks are rejected.",
      inputSchema: { id: cardIdSchema, blockedBy: z.number().int().positive() },
    },
    safe(({ id, blockedBy }) => {
      const { card } = write().block(id, blockedBy, actor, "mcp");
      return text(`blocked ${formatCardBrief(card)}`);
    }),
  );

  server.registerTool(
    "kanban_unblock",
    {
      title: "Unblock card",
      description:
        "Remove a dependency between card `id` and card `blockedBy`. kanban_unrelate removes it from either side.",
      inputSchema: { id: cardIdSchema, blockedBy: z.number().int().positive() },
    },
    safe(({ id, blockedBy }) => {
      const { card } = write().unblock(id, blockedBy, actor, "mcp");
      return text(`unblocked ${formatCardBrief(card)}`);
    }),
  );

  server.registerTool(
    "kanban_relate",
    {
      title: "Relate cards",
      description:
        "Link two cards as upstream/downstream. `direction` is the side `other` sits on relative to `id`: " +
        '"upstream" makes this card wait on it (a predecessor), "downstream" makes it wait on this card ' +
        "(a successor). Either spelling lands on the same edge, so a card can be many cards' predecessor " +
        "and many cards' successor at once. Cycles are rejected.",
      inputSchema: {
        id: cardIdSchema,
        other: cardIdSchema.describe(
          "The card on the other end of the relation",
        ),
        direction: z.enum(["upstream", "downstream"]),
      },
    },
    safe(({ id, other, direction }) => {
      const { card } = write().relate(id, other, direction, actor, "mcp");
      // The card that changes is always the one that ends up waiting: `id`
      // when the other card is upstream, the other card when it is downstream.
      const waiting = direction === "upstream" ? id : other;
      const waitedOn = direction === "upstream" ? other : id;
      return text(
        `related ${formatCardBrief(card)} — #${waiting} waits on #${waitedOn}`,
      );
    }),
  );

  server.registerTool(
    "kanban_unrelate",
    {
      title: "Unrelate cards",
      description:
        "Remove the relation between two cards, whichever way round it runs. A no-op when they are unrelated.",
      inputSchema: { id: cardIdSchema, other: cardIdSchema },
    },
    safe(({ id, other }) => {
      const { card } = write().unrelate(id, other, actor, "mcp");
      return text(`unrelated ${formatCardBrief(card)} from #${other}`);
    }),
  );

  server.registerTool(
    "kanban_parent",
    {
      title: "Set parent",
      description:
        "Make card `id` a child of card `parent` — composition, not blocking: an umbrella (a big goal) and the work that supports it. One level only, so the parent must not itself be a child and the child must not already have children. The two ends move together: a part cannot be in doing/review unless the umbrella is in doing, and an umbrella cannot be reviewed or done until every part is done. Re-parenting replaces the old parent in one step.",
      inputSchema: {
        id: cardIdSchema.describe("The child card"),
        parent: cardIdSchema.describe("The umbrella card it belongs to"),
      },
    },
    safe(({ id, parent }) => {
      const { card } = write().parent(id, parent, actor, "mcp");
      return text(`child of #${parent} — ${formatCardBrief(card)}`);
    }),
  );

  server.registerTool(
    "kanban_unparent",
    {
      title: "Clear parent",
      description:
        "Make card `id` a top-level card again. A no-op when it has no parent.",
      inputSchema: { id: cardIdSchema },
    },
    safe(({ id }) => {
      const { card } = write().unparent(id, actor, "mcp");
      return text(`now top-level — ${formatCardBrief(card)}`);
    }),
  );

  server.registerTool(
    "kanban_note_add",
    {
      title: "Add note",
      description:
        "Attach a remark to a card — the place for a document link, e.g. the design doc for the " +
        "requirement. `url` may be an https link or a path to a local file (docs/design.md); the Web UI " +
        "renders local markdown and HTML in place.",
      inputSchema: {
        id: cardIdSchema,
        text: z.string().min(1).describe("The remark itself"),
        url: z
          .string()
          .optional()
          .describe("Document link: https://… or a path to a local file"),
      },
    },
    safe(({ id, text: noteText, url }) => {
      const { card } = write().addNote(
        id,
        { text: noteText, url },
        actor,
        "mcp",
      );
      const note = card.notes[card.notes.length - 1];
      return text(
        `noted #${note?.id ?? "?"} on ${formatCardBrief(card)}` +
          (note?.url ? ` — ${note.url}` : ""),
      );
    }),
  );

  server.registerTool(
    "kanban_note_update",
    {
      title: "Edit note",
      description:
        "Edit a note's text and/or link. The note id is shown by kanban_show; pass url: null to clear the link.",
      inputSchema: {
        id: cardIdSchema,
        noteId: z.number().int().positive().describe("Note id"),
        text: z.string().optional(),
        url: z.string().nullish(),
      },
    },
    safe(({ id, noteId, text: noteText, url }) => {
      const { card } = write().updateNote(
        id,
        noteId,
        { text: noteText, url },
        actor,
        "mcp",
      );
      return text(`updated note #${noteId} on ${formatCardBrief(card)}`);
    }),
  );

  server.registerTool(
    "kanban_note_remove",
    {
      title: "Remove note",
      description:
        "Remove a note from a card. The note id is shown by kanban_show.",
      inputSchema: { id: cardIdSchema, noteId: z.number().int().positive() },
    },
    safe(({ id, noteId }) => {
      const { card } = write().removeNote(id, noteId, actor, "mcp");
      return text(`removed note #${noteId} from ${formatCardBrief(card)}`);
    }),
  );

  /* ------------------------------- resource ----------------------------- */

  server.registerResource(
    "board",
    "kanban://board",
    {
      title: "Kanban board",
      description: "The full board as JSON (someday/todo/doing/review/done).",
      mimeType: "application/json",
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(read().board(), null, 2),
        },
      ],
    }),
  );

  return server;
}

/* ------------------------------- internals ------------------------------ */

/** Turns thrown domain errors into `code: message` tool errors. */
function safe<Args>(
  handler: (args: Args) => CallToolResult,
): (args: Args) => CallToolResult {
  return (args: Args): CallToolResult => {
    try {
      return handler(args);
    } catch (error) {
      if (error instanceof KanbanError) {
        return {
          isError: true,
          content: [{ type: "text", text: `${error.code}: ${error.message}` }],
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text", text: `error: ${message}` }],
      };
    }
  };
}

function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

function requireCard(card: Card | null, id: number): Card {
  if (!card) {
    throw new KanbanError("card_not_found", `card ${id} not found`);
  }
  return card;
}
