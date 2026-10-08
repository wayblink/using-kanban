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
    actorName: document.getElementById("actor-name"),
    actorType: document.getElementById("actor-type"),
    filterQ: document.getElementById("filter-q"),
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
  };

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

  loadIdentity();
  void refresh();
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
