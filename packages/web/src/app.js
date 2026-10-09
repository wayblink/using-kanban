/* using-kanban — default Web UI
 *
 * Zero dependencies. The pure helpers at the top are exported so they can be
 * unit-tested in node; everything below only runs in a browser.
 */

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

export const COLUMNS = [
  { id: "todo", label: "Todo" },
  { id: "doing", label: "Doing" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

/** Dropping a card on a column maps to the matching intent verb, not a blind move. */
const COLUMN_ACTIONS = {
  todo: "reopen",
  doing: "claim",
  review: "review",
  done: "done",
};

export function actionForColumn(column) {
  const action = COLUMN_ACTIONS[column];
  if (!action) throw new Error(`unknown column: ${column}`);
  return action;
}

export function filterCards(cards, filter = {}) {
  const q = String(filter.q ?? "")
    .trim()
    .toLowerCase();
  const assignee = String(filter.assignee ?? "").trim();
  const reviewer = String(filter.reviewer ?? "").trim();

  return cards.filter((card) => {
    if (assignee && card.assignee !== assignee) return false;
    if (reviewer && card.reviewer !== reviewer) return false;
    if (q && !`${card.title} ${card.body ?? ""}`.toLowerCase().includes(q))
      return false;
    return true;
  });
}

/** Most recently touched first — the top of a column is where work is happening. */
export function sortCards(cards) {
  return [...cards].sort((a, b) => {
    if (a.updatedAt === b.updatedAt) return b.id - a.id;
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });
}

/** Ids that cannot be worked yet: any blocker that is not done (or is gone). */
export function blockedCardIds(cards) {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const blocked = new Set();
  for (const card of cards) {
    for (const dep of card.blockedBy ?? []) {
      const blocker = byId.get(dep);
      if (!blocker || blocker.state !== "done") blocked.add(card.id);
    }
  }
  return blocked;
}

export function formatRelativeTime(iso, now = Date.now()) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Card titles and bodies are user content — never inject them raw. */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

export function parseActor(stored, fallback) {
  try {
    const parsed = JSON.parse(stored);
    if (
      parsed &&
      typeof parsed.name === "string" &&
      parsed.name.trim() !== "" &&
      (parsed.type === "human" || parsed.type === "agent")
    ) {
      return { name: parsed.name.trim(), type: parsed.type };
    }
  } catch {
    // fall through
  }
  return fallback;
}

/** Distinct actor names on the board, for the filter dropdowns. */
export function actorOptions(cards, role) {
  const names = new Set();
  for (const card of cards) {
    const value = card[role];
    if (value) names.add(value);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/* ------------------------------------------------------------------ *
 * Documentation — the product home page
 * ------------------------------------------------------------------ */

const DOCS = [
  {
    id: "overview",
    title: "What is using-kanban?",
    lead: "A headless kanban board for AI agents and humans.",
    blocks: [
      {
        t: "p",
        text:
          "One board per project, stored in `.ukb/` next to your code. Agents and the human share it: " +
          "agents pick up work through MCP tools or the CLI, the human watches and steers through this UI.",
      },
      {
        t: "p",
        text:
          "The API is the product. The CLI, the MCP server, and this Web UI are all thin consumers of the same " +
          "event-sourced core — so you can build your own front end, or embed the board in another product.",
      },
      { t: "h", text: "Why it is built this way" },
      {
        t: "ul",
        items: [
          [
            "Event-sourced",
            "every change is an appended event; the board is a projection you can rebuild by replaying it. History, undo, and live updates all fall out of that.",
          ],
          [
            "No daemon",
            "the CLI and MCP server open the store directly. The HTTP server only runs when you want this UI.",
          ],
          [
            "No message bus",
            "state lives in one place. Agents poll their cards at the start of a turn; the browser gets pushed updates over SSE.",
          ],
          [
            "Swappable storage",
            "SQLite (WAL) by default, or a single JSONL file — or memory for tests.",
          ],
        ],
      },
    ],
  },
  {
    id: "workflow",
    title: "The workflow",
    lead: "Four columns, one rule: claim before you work.",
    blocks: [
      {
        t: "table",
        head: ["State", "Meaning", "How you get there"],
        rows: [
          ["todo", "ready to be picked up", "created here"],
          ["doing", "someone is actively working it", "claim"],
          ["review", "work is ready for its reviewer", "review"],
          ["done", "approved and finished", "done"],
        ],
      },
      { t: "h", text: "The one rule" },
      {
        t: "p",
        text:
          "Always claim a card before starting work on it. Claiming moves it to doing and marks you as the owner, " +
          "so nobody else duplicates the effort — and if someone got there first you get a claim_conflict instead of " +
          "silently overwriting their work.",
      },
      { t: "h", text: "Write cards an agent can act on" },
      {
        t: "p",
        text:
          "Notifications only carry the title. Put the target files and the acceptance criteria in the body — " +
          "that is what the assignee reads before starting.",
      },
      {
        t: "code",
        text: 'ukb add "implement /api/cards" \\\n  --body "target: packages/server/src/routes/cards.ts\\nAC: vitest green" \\\n  --assignee claude-code --reviewer jyxc',
      },
    ],
  },
  {
    id: "web-ui",
    title: "Using this UI",
    lead: "Drag cards between columns; the drop runs the matching verb.",
    blocks: [
      {
        t: "table",
        head: ["Drop a card on…", "…and it runs"],
        rows: [
          ["Doing", "claim — moves to doing and assigns the card to you"],
          ["Review", "review — hands it to the reviewer named on the card"],
          ["Done", "done — marks it finished (idempotent)"],
          ["Todo", "reopen — sends it back for rework"],
        ],
      },
      {
        t: "p",
        text:
          "If a claim fails — someone else is already working the card — you get the server's reason as a toast and " +
          "the board snaps back to server state. Nothing is ever silently overwritten.",
      },
      { t: "h", text: "Identity" },
      {
        t: "p",
        text:
          "The top bar is who this browser acts as. Humans and agents share one namespace, so you can be " +
          "jyxc (human) reviewing a card that claude-code (agent) implemented. Every event in a card's history " +
          "records who did it.",
      },
      { t: "h", text: "Everything else" },
      {
        t: "ul",
        items: [
          [
            "Card drawer",
            "click any card to edit title/body/assignee/reviewer, run transitions, manage blockers, read the event history, or delete it (creator only).",
          ],
          ["Filters", "filter by text, assignee, and reviewer."],
          [
            "Live",
            "the board updates over SSE — cards moved by an agent, the CLI, or another browser tab appear without a refresh.",
          ],
          ["Keyboard", "Enter opens a focused card, Escape closes panels."],
        ],
      },
    ],
  },
  {
    id: "cli",
    title: "The ukb CLI",
    lead: "Same board, no server, no daemon.",
    blocks: [
      {
        t: "code",
        text:
          "ukb                              # your open cards — a call to act, not a list\\n" +
          "ukb board                        # the whole board\\n" +
          "ukb show 3                       # detail + event history\\n" +
          'ukb add "fix the flaky test" --body "AC: green on CI" --assignee codex --reviewer jyxc\\n' +
          "ukb claim 3                      # todo → doing, assigned to you\\n" +
          "ukb review 3                     # → review\\n" +
          "ukb done 3                       # → done\\n" +
          "ukb reopen 3                     # → todo\\n" +
          "ukb move 3 doing\\n" +
          'ukb edit 3 --body "…"            # empty string clears a field\\n' +
          "ukb block 4 --by 3               # dependencies\\n" +
          "ukb web                          # start the API + this UI\\n" +
          "ukb doctor                       # is this project wired up?",
      },
      {
        t: "p",
        text:
          "Agents pass --agent <name> --agent-type agent so cards are attributable; UKB_AGENT and UKB_DIR work as " +
          "environment equivalents. Failures exit non-zero with the stable code, e.g. " +
          "claim_conflict: card 3 is already being worked by codex.",
      },
    ],
  },
  {
    id: "mcp",
    title: "Connecting an agent",
    lead: "One command per framework.",
    blocks: [
      {
        t: "code",
        text:
          "ukb init --for claude-code           # writes .mcp.json + CLAUDE.md\\n" +
          "ukb init --for codex                 # marker block in ~/.codex/config.toml + AGENTS.md\\n" +
          "ukb init --for opencode              # merges opencode.json + AGENTS.md\\n" +
          "ukb init --for claude-code --browser # …plus the Playwright MCP server",
      },
      {
        t: "p",
        text:
          "The AGENTS.md / CLAUDE.md snippet is what teaches the workflow — claim before working, review when ready — " +
          "so even an agent that never reads these docs behaves correctly.",
      },
      { t: "h", text: "The tools an agent gets" },
      {
        t: "table",
        head: ["Tool", "Purpose"],
        rows: [
          ["kanban_my_cards", "your open cards — the call to act"],
          ["kanban_review_queue", "cards waiting for your review"],
          [
            "kanban_board / kanban_show",
            "the whole board / one card with history",
          ],
          [
            "kanban_add / kanban_edit / kanban_delete",
            "create, edit (creator or assignee), delete (creator only)",
          ],
          [
            "kanban_claim / kanban_review / kanban_done / kanban_reopen / kanban_move",
            "the transitions",
          ],
          ["kanban_block / kanban_unblock", "dependencies"],
        ],
      },
    ],
  },
  {
    id: "api",
    title: "Build your own UI",
    lead: "The HTTP API is the contract — this page is just one consumer of it.",
    blocks: [
      {
        t: "table",
        head: ["Method", "Path", "Purpose"],
        rows: [
          ["GET", "/api/board", "columns + cards"],
          ["GET", "/api/cards?state=open&assignee=me&q=text", "filtered cards"],
          ["GET", "/api/cards/:id", "card + event history"],
          ["POST", "/api/cards", "create a card (todo)"],
          ["PATCH", "/api/cards/:id", "edit fields"],
          [
            "POST",
            "/api/cards/:id/{claim,review,done,reopen,move}",
            "transitions",
          ],
          ["POST", "/api/cards/:id/{block,unblock}", "dependencies"],
          ["DELETE", "/api/cards/:id", "delete (creator only)"],
          ["GET", "/api/events", "SSE stream of the shared log"],
          ["GET", "/openapi.json", "the full spec"],
        ],
      },
      { t: "h", text: "Auth" },
      {
        t: "p",
        text:
          "Bound to 127.0.0.1 with a generated token. Mutations always need it — Authorization: Bearer <token>, or " +
          "?token=<token> which is how a browser EventSource passes it. Reads are free on loopback and need the token " +
          "once you bind elsewhere. Start it with ukb-server --host 0.0.0.0 --token <yours> to embed it.",
      },
      { t: "h", text: "Identity and concurrency" },
      {
        t: "ul",
        items: [
          [
            "Who acted",
            "send X-Actor-Name and X-Actor-Type: human|agent; X-Source tags where the event came from.",
          ],
          [
            "Optimistic concurrency",
            "send If-Match: <revision> (or expectedRevision in the body). A stale revision gets 409 revision_conflict instead of clobbering a concurrent edit.",
          ],
          [
            "Live updates",
            "subscribe to /api/events with ?since=<id> to backfill, then stream. Mutations from the CLI and MCP servers show up there too.",
          ],
        ],
      },
    ],
  },
  {
    id: "concepts",
    title: "Concepts",
    lead: "The five things worth knowing.",
    blocks: [
      {
        t: "ul",
        items: [
          [
            "Actors",
            "{ type: human | agent, name }. One namespace, so a human can review an agent's card and vice versa.",
          ],
          [
            "Dependencies",
            "a card can wait on others (block 4 --by 3). Cycles and self-blocks are rejected. A card with unfinished blockers is flagged, not hidden.",
          ],
          [
            "Revisions",
            "every mutation bumps the card's revision. That is what makes concurrent edits safe across the CLI, MCP, and browser.",
          ],
          [
            "Permissions are cooperative",
            "delete is creator-only, edit is creator-or-assignee — based on the actor name you send, not cryptography. Fine for a local board.",
          ],
          [
            "Storage",
            "sqlite (WAL, multi-process safe) by default; jsonl for a zero-dependency, git-friendly board; memory for tests. Switch with --storage or UKB_STORAGE.",
          ],
        ],
      },
    ],
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    lead: "What the errors mean and what to do.",
    blocks: [
      {
        t: "table",
        head: ["Error", "Meaning", "Fix"],
        rows: [
          [
            "claim_conflict",
            "someone else is already working that card",
            "pick another card, or ask them to reopen it",
          ],
          [
            "forbidden",
            "you are neither the creator nor the assignee",
            "have the creator or assignee make the change",
          ],
          [
            "card_not_found",
            "the id does not exist on this board",
            "ukb board to see the real ids",
          ],
          [
            "revision_conflict",
            "the card changed since you read it",
            "re-read it (ukb show / GET /api/cards/:id) and retry",
          ],
          [
            "invalid_state",
            "the transition does not make sense (e.g. claiming a done card)",
            "check the card's current state first",
          ],
          [
            "unauthorized",
            "mutation without a token",
            "pass the token from the ukb web URL",
          ],
        ],
      },
      {
        t: "p",
        text:
          "Agents: run ukb (or kanban_my_cards) from the project you want to board — the store is .ukb/ in the " +
          "current directory. If identity cannot be resolved, pass --agent <name>.",
      },
    ],
  },
];

/** The documentation content, exported for tests. */
export const DOCS_SECTIONS = DOCS;

/* ------------------------------------------------------------------ *
 * Browser app
 * ------------------------------------------------------------------ */

if (typeof document !== "undefined" && typeof window !== "undefined") {
  startApp();
}

function startApp() {
  const TOKEN = new URLSearchParams(window.location.search).get("token") ?? "";
  const STORAGE_KEY = "using-kanban.actor";

  const els = {
    board: document.getElementById("board"),
    docs: document.getElementById("docs"),
    actorName: document.getElementById("actor-name"),
    actorType: document.getElementById("actor-type"),
    filterQ: document.getElementById("filter-q"),
    filters: document.getElementById("filters"),
    filterAssignee: document.getElementById("filter-assignee"),
    filterReviewer: document.getElementById("filter-reviewer"),
    live: document.getElementById("live"),
    newCard: document.getElementById("new-card"),
    drawerBackdrop: document.getElementById("drawer-backdrop"),
    drawer: document.getElementById("drawer"),
    modalBackdrop: document.getElementById("modal-backdrop"),
    modal: document.getElementById("modal"),
    toasts: document.getElementById("toasts"),
  };

  const state = {
    cards: [],
    actor: { name: "me", type: "human" },
    filter: { q: "", assignee: "", reviewer: "" },
    openCardId: null,
    dragCardId: null,
    route: currentRoute(),
  };

  /** `#/board` or `#/docs` — the docs page is the home page. */
  function currentRoute() {
    const hash = window.location.hash.replace(/^#\/?/, "");
    return hash.startsWith("board") ? "board" : "docs";
  }

  function applyRoute() {
    state.route = currentRoute();
    const onDocs = state.route === "docs";

    els.board.hidden = onDocs;
    els.docs.hidden = !onDocs;
    els.actorName.parentElement.hidden = onDocs;
    els.filters.hidden = onDocs;
    els.live.hidden = onDocs;
    els.newCard.hidden = onDocs;

    for (const link of document.querySelectorAll(".nav-link")) {
      const active = link.dataset.route === state.route;
      link.classList.toggle("active", active);
      link.setAttribute("aria-current", active ? "page" : "false");
    }

    if (onDocs) {
      closeDrawer();
      closeModal();
      void renderDocs();
    } else {
      void refresh();
    }
  }

  window.addEventListener("hashchange", applyRoute);

  /* ------------------------------- api ------------------------------- */

  function apiUrl(path) {
    const separator = path.includes("?") ? "&" : "?";
    return TOKEN
      ? `${path}${separator}token=${encodeURIComponent(TOKEN)}`
      : path;
  }

  async function api(path, options = {}) {
    const response = await fetch(apiUrl(path), {
      method: options.method ?? "GET",
      headers: {
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        "X-Actor-Name": state.actor.name,
        "X-Actor-Type": state.actor.type,
        ...(options.headers ?? {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const payload = await response.json();
        if (payload?.error?.message) message = payload.error.message;
        if (payload?.error?.code) message = `${payload.error.code}: ${message}`;
      } catch {
        // keep the status message
      }
      throw new Error(message);
    }
    return response.status === 204 ? null : response.json();
  }

  /* ----------------------------- identity ---------------------------- */

  function loadIdentity() {
    const fallback = { name: "me", type: "human" };
    state.actor = parseActor(
      window.localStorage.getItem(STORAGE_KEY),
      fallback,
    );
    els.actorName.value = state.actor.name;
    els.actorType.value = state.actor.type;
  }

  function saveIdentity() {
    state.actor = {
      name: els.actorName.value.trim() || "me",
      type: els.actorType.value === "agent" ? "agent" : "human",
    };
    els.actorName.value = state.actor.name;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.actor));
    render();
  }

  /* ------------------------------ board ------------------------------ */

  async function refresh() {
    try {
      const board = await api("/api/board");
      state.cards = [
        ...board.todo,
        ...board.doing,
        ...board.review,
        ...board.done,
      ];
      render();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  let refreshTimer = null;
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, 60);
  }

  function connectLive() {
    const source = new EventSource(apiUrl("/api/events"));
    source.onopen = () => setLive("live");
    source.onmessage = () => scheduleRefresh();
    source.onerror = () => setLive("offline"); // EventSource reconnects on its own
  }

  function setLive(next) {
    els.live.dataset.state = next;
    els.live.textContent =
      next === "live"
        ? "live"
        : next === "offline"
          ? "reconnecting…"
          : "connecting…";
  }

  /* ----------------------------- rendering --------------------------- */

  function render() {
    if (state.route !== "board") return;
    renderBoard();
    renderFilterOptions();
    if (state.openCardId !== null) renderDrawer();
  }

  function renderBoard() {
    const visible = filterCards(state.cards, state.filter);
    const blocked = blockedCardIds(state.cards);
    els.board.textContent = "";

    for (const column of COLUMNS) {
      const section = document.createElement("section");
      section.className = "column";
      section.dataset.column = column.id;
      section.style.setProperty("--col-color", `var(--col-${column.id})`);

      const header = document.createElement("div");
      header.className = "column-header";
      const dot = document.createElement("span");
      dot.className = "dot";
      const label = document.createElement("span");
      label.textContent = column.label;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(
        visible.filter((card) => card.state === column.id).length,
      );
      header.append(dot, label, count);

      const list = document.createElement("div");
      list.className = "card-list";
      const cards = sortCards(
        visible.filter((card) => card.state === column.id),
      );
      if (cards.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "nothing here";
        list.append(empty);
      }
      for (const card of cards) {
        list.append(renderCard(card, blocked.has(card.id)));
      }

      section.append(header, list);
      attachDropTarget(section, column.id);
      els.board.append(section);
    }
  }

  function renderCard(card, blocked) {
    const element = document.createElement("article");
    element.className = "card";
    element.draggable = true;
    element.dataset.cardId = String(card.id);
    element.tabIndex = 0;

    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = card.title;

    const meta = document.createElement("div");
    meta.className = "card-meta";
    if (card.assignee) {
      meta.append(
        badge(
          `@${card.assignee}`,
          card.assignee === state.actor.name ? "assignee mine" : "assignee",
        ),
      );
    }
    if (card.reviewer)
      meta.append(badge(`review: ${card.reviewer}`, "reviewer"));
    if (blocked) meta.append(badge("blocked", "blocked"));
    meta.append(badge(formatRelativeTime(card.updatedAt), ""));

    element.append(title, meta);

    element.addEventListener("click", () => openDrawer(card.id));
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDrawer(card.id);
      }
    });
    element.addEventListener("dragstart", (event) => {
      state.dragCardId = card.id;
      element.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(card.id));
    });
    element.addEventListener("dragend", () => {
      state.dragCardId = null;
      element.classList.remove("dragging");
      for (const column of els.board.querySelectorAll(".column")) {
        column.classList.remove("drop-target");
      }
    });

    return element;
  }

  function badge(text, className) {
    const element = document.createElement("span");
    element.className = `badge ${className}`.trim();
    element.textContent = text;
    return element;
  }

  function attachDropTarget(section, column) {
    section.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      section.classList.add("drop-target");
    });
    section.addEventListener("dragleave", () =>
      section.classList.remove("drop-target"),
    );
    section.addEventListener("drop", async (event) => {
      event.preventDefault();
      section.classList.remove("drop-target");
      const id = Number(
        event.dataTransfer.getData("text/plain") || state.dragCardId,
      );
      if (!Number.isInteger(id) || id <= 0) return;
      const card = state.cards.find((entry) => entry.id === id);
      if (!card || card.state === column) return;
      await transition(id, actionForColumn(column));
    });
  }

  function renderFilterOptions() {
    fillSelect(
      els.filterAssignee,
      actorOptions(state.cards, "assignee"),
      "any assignee",
    );
    fillSelect(
      els.filterReviewer,
      actorOptions(state.cards, "reviewer"),
      "any reviewer",
    );
  }

  function fillSelect(select, values, anyLabel) {
    const current = select.value;
    select.textContent = "";
    const any = document.createElement("option");
    any.value = "";
    any.textContent = anyLabel;
    select.append(any);
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    select.value = values.includes(current) ? current : "";
    state.filter[select === els.filterAssignee ? "assignee" : "reviewer"] =
      select.value;
  }

  /* ----------------------------- mutations --------------------------- */

  async function transition(id, action) {
    const endpoints = {
      claim: "claim",
      review: "review",
      done: "done",
      reopen: "reopen",
      move: "move",
    };
    const endpoint = endpoints[action];
    if (!endpoint) throw new Error(`unknown action ${action}`);
    try {
      await api(`/api/cards/${id}/${endpoint}`, { method: "POST", body: {} });
      await refresh();
    } catch (error) {
      toast(error.message, "error");
      await refresh(); // the server is the source of truth
    }
  }

  /* ------------------------------- drawer ---------------------------- */

  async function openDrawer(id) {
    state.openCardId = id;
    els.drawerBackdrop.hidden = false;
    els.drawer.hidden = false;
    await renderDrawer();
  }

  function closeDrawer() {
    state.openCardId = null;
    els.drawerBackdrop.hidden = true;
    els.drawer.hidden = true;
    els.drawer.textContent = "";
  }

  async function renderDrawer() {
    const id = state.openCardId;
    if (id === null) return;
    let card = state.cards.find((entry) => entry.id === id);
    if (!card) {
      try {
        const payload = await api(`/api/cards/${id}`);
        card = payload.card;
      } catch {
        closeDrawer();
        return;
      }
    }

    els.drawer.textContent = "";

    const header = document.createElement("div");
    header.className = "drawer-header";
    const heading = document.createElement("h2");
    heading.textContent = `#${card.id} ${card.title}`;
    const pill = document.createElement("span");
    pill.className = "state-pill";
    pill.textContent = card.state;
    const close = document.createElement("button");
    close.className = "icon-button";
    close.type = "button";
    close.textContent = "✕";
    close.setAttribute("aria-label", "close");
    close.addEventListener("click", closeDrawer);
    header.append(heading, pill, close);

    const body = document.createElement("div");
    body.className = "drawer-body";

    // editable fields
    body.append(
      field(
        "Title",
        textInput(card.title, async (value) => {
          await saveCard(id, { title: value });
        }),
      ),
      field(
        "Body",
        textArea(card.body ?? "", async (value) => {
          await saveCard(id, { body: value });
        }),
      ),
    );

    const assignee = document.createElement("div");
    assignee.className = "row";
    assignee.append(
      field(
        "Assignee",
        textInput(card.assignee ?? "", async (value) => {
          await saveCard(id, { assignee: value });
        }),
      ),
      field(
        "Reviewer",
        textInput(card.reviewer ?? "", async (value) => {
          await saveCard(id, { reviewer: value });
        }),
      ),
    );
    body.append(assignee);

    // actions
    const actions = document.createElement("div");
    actions.className = "actions";
    for (const [label, action, enabled] of [
      ["Claim", "claim", card.state === "todo"],
      [
        "Request review",
        "review",
        card.state !== "done" && card.state !== "review",
      ],
      ["Done", "done", card.state !== "done"],
      ["Reopen", "reopen", card.state !== "todo"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.disabled = !enabled;
      button.addEventListener("click", () => void transition(id, action));
      actions.append(button);
    }
    body.append(actions);

    // blockers
    const blockersField = field("Blocked by");
    const blockers = document.createElement("div");
    blockers.className = "blockers";
    const blockersOf = (candidate) => candidate.blockedBy ?? [];
    if (blockersOf(card).length === 0) {
      const none = document.createElement("span");
      none.className = "badge";
      none.textContent = "—";
      blockers.append(none);
    }
    for (const blockerId of blockersOf(card)) {
      const blocker = state.cards.find((entry) => entry.id === blockerId);
      const chip = document.createElement("span");
      chip.className = "badge";
      chip.textContent = `#${blockerId}${blocker ? ` ${blocker.title} (${blocker.state})` : ""}`;
      const remove = document.createElement("button");
      remove.className = "icon-button";
      remove.type = "button";
      remove.textContent = "✕";
      remove.setAttribute("aria-label", `unblock ${blockerId}`);
      remove.addEventListener("click", async () => {
        try {
          await api(`/api/cards/${id}/unblock`, {
            method: "POST",
            body: { blockedBy: blockerId },
          });
          await refresh();
        } catch (error) {
          toast(error.message, "error");
        }
      });
      chip.append(remove);
      blockers.append(chip);
    }
    const blockInput = document.createElement("input");
    blockInput.type = "number";
    blockInput.placeholder = "block on card #";
    blockInput.min = "1";
    const blockButton = document.createElement("button");
    blockButton.type = "button";
    blockButton.textContent = "Block";
    blockButton.addEventListener("click", async () => {
      const blockedBy = Number(blockInput.value);
      if (!Number.isInteger(blockedBy) || blockedBy <= 0) {
        toast("enter a card id to block on", "error");
        return;
      }
      try {
        await api(`/api/cards/${id}/block`, {
          method: "POST",
          body: { blockedBy },
        });
        blockInput.value = "";
        await refresh();
      } catch (error) {
        toast(error.message, "error");
      }
    });
    blockers.append(blockInput, blockButton);
    blockersField.append(blockers);
    body.append(blockersField);

    // history
    const historyField = field("History");
    const list = document.createElement("ul");
    list.className = "history";
    try {
      const payload = await api(`/api/cards/${id}/history`);
      for (const event of payload.events) {
        const item = document.createElement("li");
        const who = document.createElement("span");
        who.className = "who";
        who.textContent = `${event.actor.type}/${event.actor.name}`;
        const what = document.createElement("span");
        what.textContent = `${describeEvent(event)} · ${formatRelativeTime(event.ts)}`;
        item.append(who, what);
        list.append(item);
      }
    } catch {
      // history is best-effort
    }
    historyField.append(list);
    body.append(historyField);

    // delete
    const danger = document.createElement("div");
    danger.className = "actions";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "Delete card";
    del.addEventListener("click", async () => {
      if (!window.confirm(`Delete card #${id}? This cannot be undone.`)) return;
      try {
        await api(`/api/cards/${id}`, { method: "DELETE" });
        toast(`deleted #${id}`);
        closeDrawer();
        await refresh();
      } catch (error) {
        toast(error.message, "error");
      }
    });
    danger.append(del);
    body.append(danger);

    els.drawer.append(header, body);
  }

  async function saveCard(id, patch) {
    try {
      await api(`/api/cards/${id}`, { method: "PATCH", body: patch });
      await refresh();
    } catch (error) {
      toast(error.message, "error");
      await refresh();
    }
  }

  /* -------------------------------- modal ---------------------------- */

  function openModal() {
    els.modal.textContent = "";
    const heading = document.createElement("h2");
    heading.textContent = "New card";

    const title = textInput("", () => {});
    const bodyInput = textArea("", () => {});
    const assignee = textInput(state.actor.name, () => {});
    const reviewer = textInput("", () => {});

    const row = document.createElement("div");
    row.className = "row";
    row.append(field("Assignee", assignee), field("Reviewer", reviewer));

    const form = document.createElement("div");
    form.className = "drawer-body";
    form.append(
      field("Title", title),
      field("Body — target files, acceptance criteria", bodyInput),
      row,
    );

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", closeModal);
    const create = document.createElement("button");
    create.type = "button";
    create.className = "primary";
    create.textContent = "Create card";
    create.addEventListener("click", async () => {
      if (!title.value.trim()) {
        toast("a card needs a title", "error");
        return;
      }
      try {
        await api("/api/cards", {
          method: "POST",
          body: {
            title: title.value.trim(),
            body: bodyInput.value.trim() || undefined,
            assignee: assignee.value.trim() || undefined,
            reviewer: reviewer.value.trim() || undefined,
          },
        });
        closeModal();
        await refresh();
      } catch (error) {
        toast(error.message, "error");
      }
    });
    actions.append(cancel, create);

    els.modal.append(heading, form, actions);
    els.modalBackdrop.hidden = false;
    els.modal.hidden = false;
    title.focus();
  }

  function closeModal() {
    els.modalBackdrop.hidden = true;
    els.modal.hidden = true;
    els.modal.textContent = "";
  }

  /* -------------------------------- docs ------------------------------ */

  async function renderDocs() {
    const hero = document.createElement("header");
    hero.className = "docs-hero";

    const title = document.createElement("h1");
    title.textContent = "using-kanban";

    const tagline = document.createElement("p");
    tagline.className = "docs-tagline";
    tagline.textContent =
      "A headless kanban for AI agents and humans — the API is the product, UIs are pluggable.";

    const cta = document.createElement("a");
    cta.className = "docs-cta";
    cta.href = "#/board";
    cta.textContent = "Open the board →";

    const status = document.createElement("p");
    status.className = "docs-status";
    status.textContent = "loading board…";

    hero.append(title, tagline, cta, status);

    const layout = document.createElement("div");
    layout.className = "docs-layout";

    const toc = document.createElement("nav");
    toc.className = "docs-toc";
    toc.setAttribute("aria-label", "documentation sections");
    for (const section of DOCS) {
      const link = document.createElement("a");
      link.href = `#/docs/${section.id}`;
      link.textContent = section.title;
      link.dataset.section = section.id;
      toc.append(link);
    }

    const article = document.createElement("article");
    article.className = "docs-body";
    for (const section of DOCS) {
      article.append(renderDocsSection(section));
    }

    layout.append(toc, article);
    els.docs.textContent = "";
    els.docs.append(hero, layout);

    // live counts in the hero, straight from the API
    void api("/api/me")
      .then((info) => {
        const counts = info.counts ?? {};
        status.textContent =
          `${counts.todo ?? 0} todo · ${counts.doing ?? 0} doing · ` +
          `${counts.review ?? 0} review · ${counts.done ?? 0} done — ` +
          `acting as ${info.actor?.name ?? state.actor.name}`;
      })
      .catch(() => {
        status.textContent = "board unavailable";
      });
  }

  function renderDocsSection(section) {
    const wrapper = document.createElement("section");
    wrapper.className = "docs-section";
    wrapper.id = `docs-${section.id}`;

    const heading = document.createElement("h2");
    heading.textContent = section.title;

    const lead = document.createElement("p");
    lead.className = "docs-lead";
    lead.textContent = section.lead;

    wrapper.append(heading, lead);
    for (const block of section.blocks) {
      wrapper.append(renderDocsBlock(block));
    }
    return wrapper;
  }

  function renderDocsBlock(block) {
    switch (block.t) {
      case "h": {
        const element = document.createElement("h3");
        element.textContent = block.text;
        return element;
      }
      case "p": {
        const element = document.createElement("p");
        element.textContent = block.text;
        return element;
      }
      case "code": {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = block.text;
        pre.append(code);
        return pre;
      }
      case "ul": {
        const list = document.createElement("ul");
        list.className = "docs-list";
        for (const [term, description] of block.items) {
          const item = document.createElement("li");
          const strong = document.createElement("strong");
          strong.textContent = term;
          const span = document.createElement("span");
          span.textContent = ` — ${description}`;
          item.append(strong, span);
          list.append(item);
        }
        return list;
      }
      case "table": {
        const table = document.createElement("table");
        table.className = "docs-table";
        const head = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (const cell of block.head) {
          const th = document.createElement("th");
          th.textContent = cell;
          headRow.append(th);
        }
        head.append(headRow);
        const body = document.createElement("tbody");
        for (const row of block.rows) {
          const tr = document.createElement("tr");
          for (const [index, cell] of row.entries()) {
            const td = document.createElement("td");
            td.textContent = cell;
            if (index === 0) td.className = "docs-term";
            tr.append(td);
          }
          body.append(tr);
        }
        table.append(head, body);
        return table;
      }
      default:
        return document.createComment("unknown block");
    }
  }

  /* ------------------------------- toasts ---------------------------- */

  function toast(message, kind = "info") {
    const element = document.createElement("div");
    element.className = `toast ${kind}`;
    element.textContent = message;
    els.toasts.append(element);
    window.setTimeout(() => element.remove(), 5000);
  }

  /* ------------------------------- wiring ---------------------------- */

  els.newCard.addEventListener("click", openModal);
  els.drawerBackdrop.addEventListener("click", closeDrawer);
  els.modalBackdrop.addEventListener("click", closeModal);
  els.actorName.addEventListener("change", saveIdentity);
  els.actorType.addEventListener("change", saveIdentity);
  els.filterQ.addEventListener("input", () => {
    state.filter.q = els.filterQ.value;
    renderBoard();
  });
  els.filterAssignee.addEventListener("change", () => {
    state.filter.assignee = els.filterAssignee.value;
    renderBoard();
  });
  els.filterReviewer.addEventListener("change", () => {
    state.filter.reviewer = els.filterReviewer.value;
    renderBoard();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDrawer();
      closeModal();
    }
  });

  // A boot failure must never leave a blank screen — show it.
  window.addEventListener("error", (event) => {
    toast(`ui error: ${event.message}`, "error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason =
      event.reason instanceof Error
        ? event.reason.message
        : String(event.reason);
    toast(`ui error: ${reason}`, "error");
  });

  loadIdentity();
  applyRoute();
  connectLive();
}

/* ----------------------------- dom helpers ---------------------------- */

function field(label, ...controls) {
  const wrapper = document.createElement("div");
  wrapper.className = "field";
  const labelEl = document.createElement("label");
  labelEl.textContent = label;
  wrapper.append(labelEl, ...controls);
  return wrapper;
}

function textInput(value, onChange) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.addEventListener("change", () => onChange(input.value));
  return input;
}

function textArea(value, onChange) {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.addEventListener("change", () => onChange(textarea.value));
  return textarea;
}

function describeEvent(event) {
  switch (event.type) {
    case "card.created":
      return "created";
    case "card.updated":
      return "edited";
    case "card.moved": {
      const payload = event.payload ?? {};
      return `${payload.action ?? "moved"} ${payload.from ?? "?"}→${payload.to ?? "?"}`;
    }
    case "card.deleted":
      return "deleted";
    case "card.dependency_added":
      return `blocked on #${event.payload?.blockedBy ?? "?"}`;
    case "card.dependency_removed":
      return `unblocked from #${event.payload?.blockedBy ?? "?"}`;
    default:
      return event.type;
  }
}
