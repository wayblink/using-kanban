/* using-kanban — default Web UI
 *
 * Zero dependencies. The pure helpers at the top are exported so they can be
 * unit-tested in node; everything below only runs in a browser.
 */

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

/** How many finished cards a collapsed `done` column shows before "show the rest". */
export const DONE_PREVIEW = 8;

/**
 * Which cards a column renders, and whether it is showing a preview.
 *
 * `done` is history and `someday` is a shelf, so both are previewed by
 * default: on a centralised board either can grow without bound, and rendering
 * all of them pushes the live columns off the screen. The three live columns
 * are never previewed — a long review queue is exactly what someone needs to
 * see.
 */
export function previewCards(cards, columnId, expanded = false) {
  const all = [...cards];
  if (
    (columnId !== "done" && columnId !== "someday") ||
    all.length <= DONE_PREVIEW ||
    expanded
  ) {
    return { cards: all, shown: all.length, hidden: 0, collapsed: false };
  }
  return {
    cards: all.slice(0, DONE_PREVIEW),
    shown: DONE_PREVIEW,
    hidden: all.length - DONE_PREVIEW,
    collapsed: true,
  };
}

export const COLUMNS = [
  { id: "someday", label: "Someday" },
  { id: "todo", label: "Todo" },
  { id: "doing", label: "Doing" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

/**
 * Dropping a card on a column maps to the matching intent verb, not a blind
 * move. `someday` is the exception: there is no intent verb for parking, so it
 * is a `move` with `{ to: "someday" }` — see the drop handler.
 */
const COLUMN_ACTIONS = {
  someday: "move",
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
  const project = String(filter.project ?? "").trim();

  return cards.filter((card) => {
    if (assignee && card.assignee !== assignee) return false;
    if (reviewer && card.reviewer !== reviewer) return false;
    if (project && card.project !== project) return false;
    if (q && !cardHaystack(card).includes(q)) return false;
    return true;
  });
}

/** Everything a text search looks at — notes included, links and all. */
function cardHaystack(card) {
  const notes = (card.notes ?? [])
    .map((note) => `${note.text ?? ""} ${note.url ?? ""}`)
    .join(" ");
  return `${card.title} ${card.body ?? ""} ${notes}`.toLowerCase();
}

/** Priority bands, in the order the board's other doors use. */
const PRIORITY_ORDER = ["high", "normal", "low"];

/** The closed set, in sort order — the card dialog and the modal both use it. */
const PRIORITY_OPTIONS = [...PRIORITY_ORDER];

function priorityRank(card) {
  const index = PRIORITY_ORDER.indexOf(card.priority ?? "normal");
  return index === -1 ? PRIORITY_ORDER.indexOf("normal") : index;
}

/**
 * Priority first, then most recently touched.
 *
 * Recency alone was the right rule when every card was equally wanted. With
 * priorities it puts a shelved idea above live work just because someone
 * touched it last week, which is the same complaint the overlay's ordering
 * fixes. Within a band, the top of a column is still where work is happening.
 */
export function sortCards(cards) {
  return [...cards].sort((a, b) => {
    const byPriority = priorityRank(a) - priorityRank(b);
    if (byPriority !== 0) return byPriority;
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

/* ------------------------------------------------------------------ *
 * Documents behind a note's link
 * ------------------------------------------------------------------ */

const MARKDOWN_FILE = /\.(md|markdown|mdown|mkd)$/i;
const HTML_FILE = /\.(?:x?html?)$/i;

/**
 * What the UI does with a note's link.
 *
 * `link` is a hosted URL — open it in a tab. Everything else is treated as a
 * path to a file on this machine, which the server reads for the UI (see
 * `GET /api/doc`), so a note can point at the design doc in the repo the card
 * is about without that doc being served anywhere.
 */
export function docKindOf(url) {
  const value = String(url ?? "").trim();
  if (value === "") return null;
  if (/^https?:\/\//i.test(value)) return "link";
  const path = value.replace(/^file:\/\//, "").split(/[?#]/)[0] ?? "";
  if (MARKDOWN_FILE.test(path)) return "markdown";
  if (HTML_FILE.test(path)) return "html";
  return "text";
}

/** Schemes that must never end up in an href, whatever the document says. */
function safeUrl(url) {
  const value = String(url ?? "").trim();
  return /^(?:javascript|data|vbscript):/i.test(value) ? "" : value;
}

/** One markdown list item, or null when the line is not one. */
function listItemOf(line) {
  const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
  if (!match) return null;
  return {
    indent: match[1]?.length ?? 0,
    ordered: /\d/.test(match[2] ?? ""),
    text: match[3] ?? "",
  };
}

function isSeparatorRow(line) {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");
}

function tableCells(row) {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** Does this line start a block that a paragraph must not swallow? */
function startsBlock(line) {
  return (
    line.trim() === "" ||
    /^\s*(?:```|~~~)/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*\|/.test(line) ||
    listItemOf(line) !== null ||
    /^\s*(?:[-*_]\s*){3,}$/.test(line)
  );
}

/**
 * A small, dependency-free markdown renderer.
 *
 * The document is the user's own file, but it is still escaped before any
 * markdown is applied: markup inside a doc renders as text, never as DOM.
 * It covers what a design doc actually uses — headings, lists, tables, code
 * fences, quotes, links and images — and nothing more.
 *
 * `resolveHref` / `resolveSrc` map a relative reference onto a URL the server
 * can serve, so a doc sitting next to its diagrams still renders them.
 */
export function markdownToHtml(markdown, options = {}) {
  const lines = String(markdown ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    const fence = /^\s*(```|~~~)\s*(\S*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      const body = [];
      index += 1;
      while (index < lines.length) {
        const current = lines[index] ?? "";
        if (current.trim().startsWith(marker)) break;
        body.push(current);
        index += 1;
      }
      index += 1; // the closing fence
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      out.push(
        `<h${level}>${inlineMarkdown(heading[2] ?? "", options)}</h${level}>`,
      );
      index += 1;
      continue;
    }

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      out.push("<hr />");
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? "")) {
        quoted.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      out.push(
        `<blockquote>${markdownToHtml(quoted.join("\n"), options)}</blockquote>`,
      );
      continue;
    }

    // A table needs a header row plus a `|---|` separator directly under it.
    if (/^\s*\|/.test(line)) {
      const rows = [];
      let peek = index;
      while (peek < lines.length && /^\s*\|/.test(lines[peek] ?? "")) {
        rows.push(lines[peek] ?? "");
        peek += 1;
      }
      if (rows.length >= 2 && isSeparatorRow(rows[1] ?? "")) {
        const head = tableCells(rows[0] ?? "");
        const body = rows.slice(2).map(tableCells);
        const cells = (values, tag) =>
          values
            .map(
              (value) => `<${tag}>${inlineMarkdown(value, options)}</${tag}>`,
            )
            .join("");
        out.push(
          `<table><thead><tr>${cells(head, "th")}</tr></thead><tbody>${body
            .map((row) => `<tr>${cells(row, "td")}</tr>`)
            .join("")}</tbody></table>`,
        );
        index = peek;
        continue;
      }
    }

    if (listItemOf(line)) {
      const [html, next] = renderListBlock(lines, index, options);
      out.push(html);
      index = next;
      continue;
    }

    const paragraph = [];
    while (index < lines.length && !startsBlock(lines[index] ?? "")) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    if (paragraph.length === 0) {
      index += 1;
      continue;
    }
    out.push(
      `<p>${inlineMarkdown(paragraph.join("\n"), options).replace(
        /\n/g,
        "<br />",
      )}</p>`,
    );
  }

  return out.join("\n");
}

function renderListBlock(lines, start, options) {
  const first = listItemOf(lines[start] ?? "") ?? {
    indent: 0,
    ordered: false,
    text: "",
  };
  const { indent: baseIndent, ordered } = first;
  // Inner HTML per item, so a nested list can be appended inside its <li>.
  const contents = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim() === "") {
      // A blank line only continues the list when another item follows.
      let peek = index + 1;
      while (peek < lines.length && (lines[peek] ?? "").trim() === "") {
        peek += 1;
      }
      const next = listItemOf(lines[peek] ?? "");
      if (next && next.indent >= baseIndent && next.ordered === ordered) {
        index = peek;
        continue;
      }
      break;
    }

    const item = listItemOf(line);
    if (!item || item.ordered !== ordered) break;
    if (item.indent < baseIndent) break;

    if (item.indent > baseIndent) {
      const [nested, next] = renderListBlock(lines, index, options);
      const last = contents.length - 1;
      if (last >= 0) contents[last] = `${contents[last] ?? ""}${nested}`;
      else contents.push(nested);
      index = next;
      continue;
    }

    let text = item.text;
    index += 1;
    // Indented lines are a continuation of this item, not a new block.
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (next.trim() === "") break;
      if (listItemOf(next)) break;
      if (!/^\s{2,}\S/.test(next)) break;
      text += ` ${next.trim()}`;
      index += 1;
    }
    contents.push(inlineMarkdown(text, options));
  }

  const tag = ordered ? "ol" : "ul";
  const items = contents.map((content) => `<li>${content}</li>`).join("");
  return [`<${tag}>${items}</${tag}>`, index];
}

/**
 * Inline markdown. Everything is escaped first; links, images and code spans
 * are swapped for placeholders so later passes cannot corrupt them, then
 * restored at the end.
 */
function inlineMarkdown(text, options = {}) {
  const resolveHref = options.resolveHref ?? ((href) => href);
  const resolveSrc = options.resolveSrc ?? ((src) => src);
  const kept = [];
  // Private-use characters as placeholders: they cannot occur in a document,
  // and unlike NUL they keep the regexes (and eslint) happy.
  const keep = (html) => {
    kept.push(html);
    return `\uE000${kept.length - 1}\uE001`;
  };

  let out = escapeHtml(text);

  out = out.replace(/`([^`]+)`/g, (_match, code) =>
    keep(`<code>${code}</code>`),
  );

  out = out.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_match, alt, src) => {
      const resolved = safeUrl(resolveSrc(src));
      if (!resolved) return keep(alt);
      return keep(`<img src="${resolved}" alt="${alt}" loading="lazy" />`);
    },
  );

  out = out.replace(
    /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_match, label, href) => {
      const resolved = safeUrl(resolveHref(href));
      if (!resolved) return keep(label);
      const external = /^https?:\/\//i.test(resolved);
      const extra = external ? ' target="_blank" rel="noreferrer"' : "";
      return keep(`<a href="${resolved}"${extra}>${label}</a>`);
    },
  );

  out = out.replace(
    /(^|[\s(])(https?:\/\/[^\s<>()]+)/g,
    (_match, lead, url) =>
      `${lead}${keep(`<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`)}`,
  );

  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_])_([^_]+)_/g, "$1<em>$2</em>");

  return out.replace(
    /\uE000(\d+)\uE001/g,
    (_match, id) => kept[Number(id)] ?? "",
  );
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

/**
 * Resolves a reference inside a document onto a URL the server can serve.
 *
 * A note's link is a path on this machine, and the document it points at lives
 * next to its own screenshots and sibling pages — so a relative reference has
 * to be resolved against the document's directory and then read through
 * `/api/doc`, not against the UI's origin.
 */
export function resolveDocRef(ref, docPath) {
  const value = String(ref ?? "").trim();
  if (value === "" || /^(?:https?:|data:|mailto:|tel:|#|\/\/)/i.test(value)) {
    return value;
  }
  const clean = value.replace(/^file:\/\//, "");
  const base = String(docPath ?? "")
    .replace(/\\/g, "/")
    .replace(/\/[^/]*$/, "");
  const joined =
    clean.startsWith("/") || clean.startsWith("~") ? clean : `${base}/${clean}`;
  return `/api/doc?raw=1&path=${encodeURIComponent(normaliseDocPath(joined))}`;
}

/** Collapses `.` and `..` without touching the filesystem. */
export function normaliseDocPath(path) {
  const out = [];
  for (const segment of String(path ?? "").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return `/${out.join("/")}`;
}

/** Rewrites relative `src`/`href` attributes in an HTML document. */
export function rewriteDocRefs(html, docPath) {
  return String(html ?? "").replace(
    /(\ssrc|\shref)\s*=\s*(["'])(.*?)\2/gi,
    (match, attribute, quote, value) =>
      `${attribute}=${quote}${resolveDocRef(value, docPath)}${quote}`,
  );
}

/* ------------------------------------------------------------------ *
 * Internationalisation
 * ------------------------------------------------------------------ */

export const LANGUAGES = [
  { code: "en", label: "EN" },
  { code: "zh", label: "中文" },
];

export const I18N = {
  en: {
    "nav.docs": "Docs",
    "nav.board": "Board",
    "nav.events": "Events",
    "events.title": "Events",
    "events.project": "Project",
    "events.anyProject": "all projects",
    "events.filterPlaceholder":
      "Filter this page by card, project, actor or action…",
    "events.perPage": "per page",
    "events.perPageOption": "{n} / page",
    "events.perPageAuto": "Auto · {n} / page",
    "events.refresh": "Refresh",
    "events.colTime": "Time",
    "events.colProject": "Project",
    "events.colActor": "Actor",
    "events.colSource": "Source",
    "events.colEvent": "Event",
    "events.colCard": "Card",
    "events.newer": "Newer",
    "events.older": "Older",
    "events.page": "Page {n} · {count} of {total} events",
    "events.pageNoTotal": "Page {n} · {count} events",
    "events.empty": "No events match.",
    "controls.actingAs": "acting as",
    "actor.human": "human",
    "actor.agent": "agent",
    "controls.filterPlaceholder": "Filter title / body…",
    "controls.anyAssignee": "any assignee",
    "controls.anyReviewer": "any reviewer",
    "controls.newCard": "+ New card",
    "live.connecting": "connecting…",
    "live.live": "live",
    "live.offline": "reconnecting…",
    "column.someday": "Someday",
    "column.todo": "Todo",
    "column.doing": "Doing",
    "column.review": "Review",
    "column.done": "Done",
    "column.showRest": "show the other {n}",
    "column.showLess": "show less",
    "column.empty": "nothing here",
    "card.project": "project:",
    "card.priority": "priority:",
    "priority.high": "high",
    "priority.normal": "normal",
    "priority.low": "low",
    "filter.anyProject": "any project",
    "filter.anyAssignee": "any assignee",
    "filter.anyReviewer": "any reviewer",
    "card.reviewer": "reviewer:",
    "card.blockedBy": "blocked-by:",
    "card.blocks": "blocks:",
    "card.parent": "parent:",
    "card.children": "children:",
    "card.notes": "notes:",
    "time.justNow": "just now",
    "time.minutes": "{n}m ago",
    "time.hours": "{n}h ago",
    "time.days": "{n}d ago",
    "time.months": "{n}mo ago",
    "time.years": "{n}y ago",
    "drawer.assignee": "Assignee",
    "drawer.reviewer": "Reviewer",
    "drawer.project": "Project",
    "drawer.priority": "Priority",
    "drawer.blockedBy": "Upstream — waits on",
    "drawer.blocks": "Downstream — waits for this",
    "drawer.hierarchy":
      "Hierarchy — the umbrella this belongs to, and its parts",
    "drawer.parent": "Set parent",
    "drawer.setParent": "parent #",
    "drawer.unparent": "detach from #{id}",
    "drawer.childProgress": "{done}/{total} done",
    "drawer.addChild": "child #",
    "drawer.addChildButton": "Add child",
    "drawer.addUpstream": "add upstream card #",
    "drawer.addDownstream": "add downstream card #",
    "drawer.relate": "Relate",
    "drawer.notes": "Notes — remarks and document links",
    "drawer.body": "Body",
    "drawer.history": "History",
    "drawer.title": "Title",
    "drawer.claim": "Claim",
    "drawer.requestReview": "Request review",
    "drawer.done": "Done",
    "drawer.reopen": "Reopen",
    "drawer.someday": "Park in someday",
    "drawer.delete": "Delete card",
    "drawer.noteText": "Remark",
    "drawer.noteUrl": "Link — https://… or a local path",
    "drawer.addNote": "Add note",
    "drawer.openDoc": "Open",
    "drawer.removeNote": "remove note {id}",
    "drawer.noNotes": "no notes yet",
    "drawer.needsText": "a note needs some text",
    "doc.title": "Document",
    "doc.loading": "loading…",
    "doc.failed": "the document could not be read",
    "doc.close": "close document",
    "doc.newTab": "open in a new tab",
    "doc.hint":
      "served from this machine — the note's link, resolved by the server",
    "drawer.createdBy": "created by",
    "drawer.revision": "revision",
    "drawer.updated": "updated",
    "drawer.none": "—",
    "drawer.close": "close",
    "drawer.unblock": "unblock {id}",
    "drawer.confirmDelete": "Delete card #{id}? This cannot be undone.",
    "modal.newCard": "New card",
    "modal.hint":
      "One unit of work: a title the next person understands, and a body naming the files to touch and what done means.",
    "modal.body": "Body — target files, acceptance criteria",
    "modal.cancel": "Cancel",
    "modal.create": "Create card",
    "modal.needsTitle": "a card needs a title",
    "modal.noProject": "no project",
    "modal.newProject": "new project…",
    "modal.projectPlaceholder": "slug — letters, digits, dot, dash",
    "modal.back": "back to the project list",
    "modal.submitHint": "{key}+Enter creates the card",
    "modal.enterId": "enter a card id to block on",
    "error.claim_conflict": "claim conflict",
    "error.forbidden": "not allowed",
    "error.card_not_found": "card not found",
    "error.revision_conflict": "revision conflict",
    "error.invalid_state": "invalid state",
    "error.unauthorized": "unauthorized",
    "error.invalid_input": "invalid input",
    "error.invalid_json": "invalid JSON",
    "error.invalid_actor": "invalid actor",
    "error.payload_too_large": "payload too large",
    "error.internal_error": "internal error",
    "error.network": "request failed",
  },
  zh: {
    "nav.docs": "文档",
    "nav.board": "看板",
    "nav.events": "事件",
    "events.title": "事件",
    "events.project": "项目",
    "events.anyProject": "全部项目",
    "events.filterPlaceholder": "在本页按卡片 / 项目 / 操作者 / 动作筛选…",
    "events.perPage": "每页",
    "events.perPageOption": "{n} / 页",
    "events.perPageAuto": "自适应 · {n} / 页",
    "events.colTime": "时间",
    "events.colProject": "项目",
    "events.colActor": "操作者",
    "events.colSource": "来源",
    "events.colEvent": "事件",
    "events.colCard": "卡片",
    "events.refresh": "刷新",
    "events.newer": "更新",
    "events.older": "更早",
    "events.page": "第 {n} 页 · 本页 {count} / 共 {total} 条",
    "events.pageNoTotal": "第 {n} 页 · 本页 {count} 条",
    "events.empty": "没有匹配的事件。",
    "controls.actingAs": "当前身份",
    "actor.human": "人类",
    "actor.agent": "智能体",
    "controls.filterPlaceholder": "筛选标题 / 内容…",
    "controls.anyAssignee": "所有负责人",
    "controls.anyReviewer": "所有审查者",
    "controls.newCard": "+ 新建卡片",
    "live.connecting": "连接中…",
    "live.live": "实时",
    "live.offline": "重连中…",
    "column.someday": "搁置",
    "column.todo": "待办",
    "column.doing": "进行中",
    "column.review": "审查中",
    "column.done": "已完成",
    "column.showRest": "显示其余 {n} 张",
    "column.showLess": "收起",
    "column.empty": "暂无卡片",
    "card.project": "项目：",
    "card.priority": "优先级：",
    "priority.high": "高",
    "priority.normal": "普通",
    "priority.low": "低",
    "filter.anyProject": "全部项目",
    "filter.anyAssignee": "全部负责人",
    "filter.anyReviewer": "全部审查者",
    "card.reviewer": "审查：",
    "card.blockedBy": "阻塞：",
    "card.blocks": "下游：",
    "card.parent": "父卡：",
    "card.children": "子卡：",
    "card.notes": "备注：",
    "time.justNow": "刚刚",
    "time.minutes": "{n} 分钟前",
    "time.hours": "{n} 小时前",
    "time.days": "{n} 天前",
    "time.months": "{n} 个月前",
    "time.years": "{n} 年前",
    "drawer.assignee": "负责人",
    "drawer.reviewer": "审查者",
    "drawer.project": "项目",
    "drawer.priority": "优先级",
    "drawer.blockedBy": "上游 — 本卡片等待",
    "drawer.blocks": "下游 — 等待本卡片",
    "drawer.hierarchy": "层级 — 所属伞卡与它的子卡",
    "drawer.parent": "设为子卡",
    "drawer.setParent": "父卡 #",
    "drawer.unparent": "从 #{id} 摘除",
    "drawer.childProgress": "{done}/{total} 已完成",
    "drawer.addChild": "子卡 #",
    "drawer.addChildButton": "添加子卡",
    "drawer.addUpstream": "添加上游卡片 #",
    "drawer.addDownstream": "添加下游卡片 #",
    "drawer.relate": "关联",
    "drawer.notes": "备注 — 说明与文档链接",
    "drawer.body": "描述",
    "drawer.history": "历史记录",
    "drawer.title": "标题",
    "drawer.claim": "认领",
    "drawer.requestReview": "提交审查",
    "drawer.done": "完成",
    "drawer.reopen": "重新打开",
    "drawer.someday": "搁置到 someday",
    "drawer.delete": "删除卡片",
    "drawer.noteText": "备注内容",
    "drawer.noteUrl": "链接 — https://… 或本机路径",
    "drawer.addNote": "添加备注",
    "drawer.openDoc": "打开",
    "drawer.removeNote": "删除备注 {id}",
    "drawer.noNotes": "暂无备注",
    "drawer.needsText": "备注需要一些文字",
    "doc.title": "文档",
    "doc.loading": "加载中…",
    "doc.failed": "无法读取该文档",
    "doc.close": "关闭文档",
    "doc.newTab": "在新标签页打开",
    "doc.hint": "由本机提供 — 服务器解析备注中的链接",
    "drawer.createdBy": "创建者",
    "drawer.revision": "版本",
    "drawer.updated": "更新于",
    "drawer.none": "—",
    "drawer.close": "关闭",
    "drawer.unblock": "解除阻塞 {id}",
    "drawer.confirmDelete": "删除卡片 #{id}？此操作无法撤销。",
    "modal.newCard": "新建卡片",
    "modal.hint":
      "一件待办的事：写一个别人能看懂的标题，描述里列出要动的文件和“完成”的标准。",
    "modal.body": "描述 — 目标文件、验收标准",
    "modal.cancel": "取消",
    "modal.create": "创建卡片",
    "modal.needsTitle": "卡片需要标题",
    "modal.noProject": "无项目",
    "modal.newProject": "新建项目…",
    "modal.projectPlaceholder": "标识 — 小写字母、数字、点、中划线",
    "modal.back": "返回项目列表",
    "modal.submitHint": "{key}+回车 创建卡片",
    "modal.enterId": "请输入要阻塞的卡片编号",
    "error.claim_conflict": "认领冲突",
    "error.forbidden": "无权操作",
    "error.card_not_found": "卡片不存在",
    "error.revision_conflict": "版本冲突",
    "error.invalid_state": "状态无效",
    "error.unauthorized": "未授权",
    "error.invalid_input": "输入无效",
    "error.invalid_json": "JSON 格式错误",
    "error.invalid_actor": "身份无效",
    "error.payload_too_large": "内容过大",
    "error.internal_error": "内部错误",
    "error.network": "请求失败",
  },
};

/* ------------------------------------------------------------------ *
 * Documentation — the product home page
 * ------------------------------------------------------------------ */

const DOCS_EN = [
  {
    id: "overview",
    title: "What is using-kanban?",
    lead: "A headless kanban board for AI agents and humans.",
    blocks: [
      {
        t: "p",
        text:
          "One board for the whole machine, stored centrally at `~/.ukb/`. Agents and the human share it: " +
          "agents pick up work through MCP tools or the CLI, the human watches and steers through this UI. " +
          "Projects are separated by the `project` field on cards, not by directory.",
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
    lead: "Five columns. The first is a shelf for later; the other four are the flow, and the rule there is claim before you work.",
    blocks: [
      {
        t: "table",
        head: ["State", "Meaning", "How you get there"],
        rows: [
          [
            "someday",
            "parked for later — nobody assigned",
            "move a card there",
          ],
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
          [
            "Someday",
            "move — parks it for later and clears its assignee and reviewer",
          ],
        ],
      },
      {
        t: "p",
        text:
          "If a claim fails — someone else is already working the card — you get the server's reason as a toast and " +
          "the board snaps back to server state. Nothing is ever silently overwritten.",
      },
      { t: "h", text: "Events — the audit trail" },
      {
        t: "p",
        text:
          "The Events page lists every operation on the board, newest first: who did it, through which door " +
          "(cli, mcp, api, web), what changed, and which project and card it touched. Filter by project, or by " +
          "card, project, actor or action within a page. The pager says how many events there are in all — " +
          "Page 1 · 25 of 340 — and " +
          "takes 25, 50, 100, 200 or Auto (a screenful) to a page; step older and newer with it, and click a " +
          "row's card to open it. It is the same event log the board is built from, read straight.",
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
            "Card dialog",
            "click any card to edit title/body/assignee/reviewer, run transitions, manage its upstream and downstream relations, attach notes, read the event history, or delete it (creator only).",
          ],
          [
            "Relations",
            "a card shows both ends of its relations: what it waits on, and what waits on it. Add from either side — the edge is one edge.",
          ],
          [
            "Notes",
            "remarks with a document link. A local markdown or HTML file opens right here in the document viewer; an https link opens in a new tab.",
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
          "ukb relate 4 --with 3 --as upstream    # name the direction\\n" +
          "ukb unrelate 4 --with 3          # drop it, either way round\\n" +
          'ukb note 4 "design doc" --url docs/design.md\\n' +
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
          "ukb init --for pi                    # registers the Pi package (extension + skill)\n" +
          "ukb init --for claude-code --browser # …plus the Playwright MCP server\n" +
          "ukb init --for claude-code --local  # point at this checkout, not the npm package",
      },
      {
        t: "p",
        text:
          "Before the packages are on npm, add --local. The default config runs " +
          "npx -y @wayblink/using-kanban-mcp, which only resolves once published; " +
          "--local instead writes an absolute path to packages/mcp/dist/bin.js in " +
          "this repo, run by the same node binary. Everything else is identical.",
      },
      {
        t: "p",
        text:
          "The AGENTS.md / CLAUDE.md snippet is what teaches the workflow — claim before working, review when ready — " +
          "so even an agent that never reads these docs behaves correctly.",
      },
      {
        t: "h",
        text: "Projects",
      },
      {
        t: "p",
        text:
          "Cards carry an optional project slug, so one board can hold several projects " +
          "and every front door can filter to just one. A card with no project is in no " +
          "project — a project filter is a partition, not an overlay.",
      },
      {
        t: "code",
        text:
          'ukb add "Fix the login bug" --project web   # set it at creation\n' +
          "ukb edit 7 --project api                     # move it later\n" +
          "ukb board --project web                      # just that project\n" +
          "ukb mine --project web                       # my work in one project",
      },
      {
        t: "p",
        text:
          "Over MCP the same three verbs take a project argument — kanban_board, " +
          "kanban_my_cards and kanban_review_queue — and kanban_projects lists the " +
          "slugs in use, so an agent never has to guess one. The REST API takes " +
          "?project= on /api/board and /api/cards, and the Web UI has a project " +
          "dropdown beside the assignee and reviewer filters.",
      },
      {
        t: "p",
        text:
          "Slugs are normalised to lowercase and restricted to letters, digits, dot, " +
          'dash and underscore, because they end up in URLs and CLI flags: "Web" and ' +
          '"web" cannot become two different projects by accident.',
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
          [
            "kanban_block / kanban_unblock",
            "dependencies — a card with an unfinished blocker cannot be claimed or moved to doing",
          ],
          [
            "kanban_relate / kanban_unrelate",
            "the same relation with a named direction (upstream/downstream), managed from either card",
          ],
          [
            "kanban_note_add / kanban_note_update / kanban_note_remove",
            "notes — remarks and document links, e.g. the design doc for the requirement",
          ],
          [
            "kanban_projects",
            "the project slugs in use — call before filtering",
          ],
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
          ["POST", "/api/cards/:id/{parent,unparent}", "umbrella ↔ parts"],
          [
            "POST",
            "/api/cards/:id/{relate,unrelate}",
            "relations — { other, direction: upstream|downstream }",
          ],
          [
            "POST",
            "/api/cards/:id/notes",
            "add a note — { text, url } (url may be a local file)",
          ],
          [
            "PATCH/DELETE",
            "/api/cards/:id/notes/:noteId",
            "edit or remove a note",
          ],
          ["DELETE", "/api/cards/:id", "delete (creator only)"],
          ["GET", "/api/doc?path=…", "the document behind a note's link"],
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
            "Relations",
            "a card can wait on others (block 4 --by 3), and others can wait on it. The edge is stored once and read from both ends — upstream (blockedBy) and downstream (blocks) — so a card is many cards' predecessor and many cards' successor at once. Cycles and self-relations are rejected, and a card with unfinished upstream work cannot be claimed.",
          ],
          [
            "Notes",
            "remarks attached to a card, each with an optional document link. The link may be https://… or a path to a file on this machine; the server reads local markdown, HTML and text for the Web UI from the directories it is allowed to see (--doc-root, the store dir, its cwd).",
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
          "Agents: run ukb (or kanban_my_cards) from anywhere — there is one board at ~/.ukb/, so the directory " +
          "you run from does not matter. Filter with --project <slug> to see one project's work. If identity " +
          "cannot be resolved, pass --agent <name>.",
      },
    ],
  },
];

const DOCS_ZH = [
  {
    id: "overview",
    title: "什么是 using-kanban？",
    lead: "一个面向 AI 智能体与人类的无头看板。",
    blocks: [
      {
        t: "p",
        text:
          "全机共用一块看板，集中存放在 `~/.ukb/`。智能体与人类共用它：智能体通过 MCP 工具或命令行认领工作，" +
          "人类通过这个界面观察与调度。项目之间靠卡片上的 `project` 字段区分，而不是靠目录。",
      },
      {
        t: "p",
        text: "API 即产品。命令行、MCP 服务器和这个 Web 界面都只是同一套事件溯源内核的薄消费者——因此你可以构建自己的前端，或把看板嵌入到其他产品中。",
      },
      { t: "h", text: "为什么这样设计" },
      {
        t: "ul",
        items: [
          [
            "事件溯源",
            "每次变更都是一条追加的事件；看板是通过重放事件得到的投影，随时可以重建。历史、撤销与实时更新都由此自然获得。",
          ],
          [
            "无守护进程",
            "命令行与 MCP 服务器直接打开存储。只有当你需要这个界面时，HTTP 服务器才会运行。",
          ],
          [
            "无消息总线",
            "状态只存在一处。智能体在每轮开始时拉取自己的卡片；浏览器则通过 SSE 接收推送更新。",
          ],
          [
            "可替换存储",
            "默认使用 SQLite（WAL），也可以是单个 JSONL 文件——或用于测试的内存存储。",
          ],
        ],
      },
    ],
  },
  {
    id: "workflow",
    title: "工作流",
    lead: "五列看板。第一列是搁置区，其余四列是工作流，规则是：先认领，再动手。",
    blocks: [
      {
        t: "table",
        head: ["状态", "含义", "如何进入"],
        rows: [
          ["someday", "搁置待议——无人负责", "把卡片移过去"],
          ["todo", "等待被认领", "创建时即在此列"],
          ["doing", "有人正在处理", "认领"],
          ["review", "工作已就绪，等待审查", "提交审查"],
          ["done", "已批准并完成", "完成"],
        ],
      },
      { t: "h", text: "唯一的一条规则" },
      {
        t: "p",
        text: "开始工作前务必先认领卡片。认领会把它移到「进行中」并将你标记为负责人，这样没人会重复劳动——如果别人抢先一步，你会收到 claim_conflict 错误，而不是悄悄覆盖他们的工作。",
      },
      { t: "h", text: "写下智能体能执行的卡片" },
      {
        t: "p",
        text: "通知只携带标题。请把目标文件和验收标准写进描述里——那才是负责人在开始前阅读的内容。",
      },
      {
        t: "code",
        text: 'ukb add "实现 /api/cards" \\\n  --body "目标：packages/server/src/routes/cards.ts\n验收：vitest 全部通过" \\\n  --assignee claude-code --reviewer jyxc',
      },
    ],
  },
  {
    id: "web-ui",
    title: "使用这个界面",
    lead: "把卡片拖到某一列，就会执行对应的语义动作。",
    blocks: [
      {
        t: "table",
        head: ["拖到…", "…就会执行"],
        rows: [
          ["进行中", "认领——移到进行中，并把卡片分配给你"],
          ["审查中", "提交审查——交给卡片上指定的审查者"],
          ["已完成", "完成——标记为已完成（幂等）"],
          ["待办", "重新打开——打回重做"],
          ["搁置", "移动——搁置待议，并清空负责人和审查者"],
        ],
      },
      {
        t: "p",
        text: "如果认领失败——已经有别人在处理这张卡片——你会看到服务端返回的原因提示，看板也会回退到服务端状态。任何操作都不会被悄悄覆盖。",
      },
      { t: "h", text: "事件 —— 审计流水" },
      {
        t: "p",
        text: "事件页按时间倒序列出看板上的每一个操作：谁做的、通过哪个入口（cli / mcp / api / web）、改了什么、动了哪个项目和哪张卡。可按项目过滤（服务端过滤，翻页时搜的是整份日志而不是当前页），也能在页内按卡片 / 项目 / 操作者 / 动作筛选。分页器会告诉你日志总共有多少 —— 第 1 页 · 本页 25 / 共 340 —— 每页可选 25 / 50 / 100 / 200 或「自适应」（一屏）；前后翻页，点行里的卡片即可打开它。它就是看板据以构建的那份事件日志，直接读出来。",
      },
      { t: "h", text: "身份" },
      {
        t: "p",
        text: "顶栏显示的是这个浏览器以谁的身份操作。人类与智能体共用同一套命名空间，因此你可以是审查 claude-code（智能体）所实现卡片的人类用户 jyxc。每张卡片的历史记录都会标注是谁做的。",
      },
      { t: "h", text: "其他功能" },
      {
        t: "ul",
        items: [
          [
            "卡片详情弹窗",
            "点击任意卡片可编辑标题/描述/负责人/审查者、执行状态流转、管理上下游关系、添加备注、查看事件历史，或删除卡片（仅创建者）。",
          ],
          [
            "上下游关系",
            "卡片会同时显示关系的两端：它等待谁，以及谁在等待它。从任意一端添加都是同一条边。",
          ],
          [
            "备注",
            "带文档链接的说明。本机的 markdown 或 HTML 文件会直接在文档查看器中打开；https 链接则在新标签页打开。",
          ],
          ["筛选", "按文本、负责人、审查者筛选。"],
          [
            "实时",
            "看板通过 SSE 更新——智能体、命令行或其他浏览器标签页移动的卡片都会自动出现，无需刷新。",
          ],
          ["键盘", "聚焦卡片后按回车打开，按 Esc 关闭面板。"],
        ],
      },
    ],
  },
  {
    id: "cli",
    title: "ukb 命令行",
    lead: "同一块看板，无需服务器，无需守护进程。",
    blocks: [
      {
        t: "code",
        text:
          "ukb                              # 我的待办卡片——这是行动的号召，不只是列表\n" +
          "ukb board                        # 整块看板\n" +
          "ukb show 3                       # 详情与事件历史\n" +
          'ukb add "修复不稳定的测试" --body "验收：CI 连续 10 次通过" --assignee codex --reviewer jyxc\n' +
          "ukb claim 3                      # 待办 → 进行中，分配给你\n" +
          "ukb review 3                     # → 审查中\n" +
          "ukb done 3                       # → 已完成\n" +
          "ukb reopen 3                     # → 待办\n" +
          "ukb move 3 doing\n" +
          'ukb edit 3 --body "…"            # 传空字符串可清空字段\n' +
          "ukb block 4 --by 3               # 依赖关系\n" +
          "ukb relate 4 --with 3 --as upstream    # 指明方向\n" +
          "ukb unrelate 4 --with 3          # 任意一端删除\n" +
          'ukb note 4 "设计文档" --url docs/design.md\n' +
          "ukb web                          # 启动 API 与这个界面\n" +
          "ukb doctor                       # 检查项目是否已配置好",
      },
      {
        t: "p",
        text: "智能体请传入 --agent <名称> --agent-type agent 以便归属卡片；也支持 UKB_AGENT 与 UKB_DIR 等环境变量。失败时会以稳定的错误码非零退出，例如 claim_conflict: card 3 is already being worked by codex。",
      },
    ],
  },
  {
    id: "mcp",
    title: "接入智能体",
    lead: "每种框架一条命令。",
    blocks: [
      {
        t: "code",
        text:
          "ukb init --for claude-code           # 写入 .mcp.json 与 CLAUDE.md\n" +
          "ukb init --for codex                 # 在 ~/.codex/config.toml 中写入标记块，并生成 AGENTS.md\n" +
          "ukb init --for opencode              # 合并 opencode.json，并生成 AGENTS.md\n" +
          "ukb init --for pi                    # 注册 Pi 包（扩展 + 技能）\n" +
          "ukb init --for claude-code --browser # …并额外加入 Playwright MCP 服务器\n" +
          "ukb init --for claude-code --local  # 指向当前代码库，而不是 npm 上的包",
      },
      {
        t: "p",
        text:
          "在包发布到 npm 之前，请加上 --local。默认配置运行的是 " +
          "npx -y @wayblink/using-kanban-mcp，只有发布后才能解析；加上 --local 则会写入本仓库中 " +
          "packages/mcp/dist/bin.js 的绝对路径，并由同一个 node 可执行文件启动。其余部分完全一致。",
      },
      {
        t: "p",
        text: "AGENTS.md / CLAUDE.md 中的片段负责传授工作流——先认领再动手、就绪后提交审查——因此即使是从不阅读这些文档的智能体也能正确行事。",
      },
      {
        t: "h",
        text: "项目",
      },
      {
        t: "p",
        text:
          "卡片可以带一个可选的 项目 标识，于是一块看板就能容纳多个项目，并且每个入口都能只过滤其中一个。 " +
          "没有项目的卡片不属于任何项目——项目过滤是一种划分，而不是叠加显示。",
      },
      {
        t: "code",
        text:
          'ukb add "修登录 bug" --project web   # 创建时设置\n' +
          "ukb edit 7 --project api                     # 之后转移\n" +
          "ukb board --project web                      # 只看该项目\n" +
          "ukb mine --project web                       # 我在该项目的工作",
      },
      {
        t: "p",
        text:
          "在 MCP 中，同样的三个动作接受 project 参数——kanban_board、kanban_my_cards 和 " +
          "kanban_review_queue——另外 kanban_projects 会列出正在使用的标识，智能体无需猜测。 " +
          "REST API 在 /api/board 和 /api/cards 上接受 ?project=，Web 界面在负责人与审查者筛选器旁 " +
          "也有一个项目下拉框。",
      },
      {
        t: "p",
        text:
          "标识会归一化为小写，并限制为字母、数字、点、连字符和下划线，因为它们会出现在 URL 和命令行参数里： " +
          '"Web" 与 "web" 不会意外变成两个不同的项目。',
      },
      { t: "h", text: "智能体获得的工具" },
      {
        t: "table",
        head: ["工具", "用途"],
        rows: [
          ["kanban_my_cards", "我的待办卡片——行动的号召"],
          ["kanban_review_queue", "等待我审查的卡片"],
          ["kanban_board / kanban_show", "整块看板 / 单张卡片及其历史"],
          [
            "kanban_add / kanban_edit / kanban_delete",
            "创建、编辑（创建者或负责人）、删除（仅创建者）",
          ],
          [
            "kanban_claim / kanban_review / kanban_done / kanban_reopen / kanban_move",
            "状态流转",
          ],
          [
            "kanban_block / kanban_unblock",
            "依赖关系——有未完成阻塞项的卡片无法被认领或移入进行中",
          ],
          [
            "kanban_relate / kanban_unrelate",
            "同一条关系，但方向显式命名（上游/下游），可从任意一张卡片操作",
          ],
          [
            "kanban_note_add / kanban_note_update / kanban_note_remove",
            "备注——说明与文档链接，例如需求的设计文档",
          ],
          ["kanban_projects", "正在使用的项目标识——过滤前先调用"],
        ],
      },
    ],
  },
  {
    id: "api",
    title: "构建你自己的界面",
    lead: "HTTP API 才是契约——这个页面只是它的一个消费者。",
    blocks: [
      {
        t: "table",
        head: ["方法", "路径", "用途"],
        rows: [
          ["GET", "/api/board", "各列与卡片"],
          ["GET", "/api/cards?state=open&assignee=me&q=文本", "筛选卡片"],
          ["GET", "/api/cards/:id", "卡片与事件历史"],
          ["POST", "/api/cards", "创建卡片（待办）"],
          ["PATCH", "/api/cards/:id", "编辑字段"],
          [
            "POST",
            "/api/cards/:id/{claim,review,done,reopen,move}",
            "状态流转",
          ],
          ["POST", "/api/cards/:id/{block,unblock}", "依赖关系"],
          ["POST", "/api/cards/:id/{parent,unparent}", "伞卡 ↔ 子卡"],
          [
            "POST",
            "/api/cards/:id/{relate,unrelate}",
            "上下游关系——{ other, direction: upstream|downstream }",
          ],
          [
            "POST",
            "/api/cards/:id/notes",
            "添加备注——{ text, url }（url 可以是本机文件）",
          ],
          ["PATCH/DELETE", "/api/cards/:id/notes/:noteId", "编辑或删除备注"],
          ["DELETE", "/api/cards/:id", "删除（仅创建者）"],
          ["GET", "/api/doc?path=…", "备注链接指向的文档"],
          ["GET", "/api/events", "共享日志的 SSE 流"],
          ["GET", "/openapi.json", "完整规范"],
        ],
      },
      { t: "h", text: "认证" },
      {
        t: "p",
        text: "默认只绑定 127.0.0.1 并使用随机生成的令牌。变更操作始终需要它——Authorization: Bearer <token>，或 ?token=<token>（浏览器的 EventSource 就是这样传递的）。回环接口上的读取是开放的，绑定到其他地址后则需要令牌。用 ukb-server --host 0.0.0.0 --token <yours> 启动即可嵌入使用。",
      },
      { t: "h", text: "身份与并发" },
      {
        t: "ul",
        items: [
          [
            "操作者",
            "发送 X-Actor-Name 与 X-Actor-Type: human|agent；X-Source 用于标注事件来源。",
          ],
          [
            "乐观并发",
            "发送 If-Match: <revision>（或请求体中的 expectedRevision）。版本过期会得到 409 revision_conflict，而不是覆盖并发的修改。",
          ],
          [
            "实时更新",
            "用 ?since=<id> 订阅 /api/events 可先补拉再持续推送。命令行与 MCP 服务器产生的变更也会出现在这里。",
          ],
        ],
      },
    ],
  },
  {
    id: "concepts",
    title: "概念",
    lead: "值得了解的五件事。",
    blocks: [
      {
        t: "ul",
        items: [
          [
            "操作者",
            "{ type: human | agent, name }。同一套命名空间，因此人类可以审查智能体的卡片，反之亦然。",
          ],
          [
            "上下游关系",
            "一张卡片可以等待其他卡片（block 4 --by 3），也可以被其他卡片等待。这条边只存一份，但从两端都能读到——上游（blockedBy）与下游（blocks）——于是一张卡片可以同时是许多卡片的前置，也是许多卡片的后置。环路与自关联会被拒绝，上游未完成的卡片无法被认领。",
          ],
          [
            "备注",
            "挂在卡片上的说明，每条可带一个文档链接。链接可以是 https://…，也可以是本机上的文件路径；服务器会为 Web 界面读取本机的 markdown、HTML 与文本，范围仅限于它被允许访问的目录（--doc-root、存储目录及其工作目录）。",
          ],
          [
            "版本号",
            "每次变更都会递增卡片的 revision。这正是命令行、MCP 与浏览器之间并发编辑安全的保证。",
          ],
          [
            "权限是协作式的",
            "删除仅限创建者，编辑限创建者或负责人——基于你发送的操作者名称，而非加密机制。对本地看板而言这已经足够。",
          ],
          [
            "存储",
            "默认 sqlite（WAL，多进程安全）；jsonl 提供零依赖、便于纳入 git 的看板；memory 用于测试。用 --storage 或 UKB_STORAGE 切换。",
          ],
        ],
      },
    ],
  },
  {
    id: "troubleshooting",
    title: "故障排查",
    lead: "错误的含义以及如何处理。",
    blocks: [
      {
        t: "table",
        head: ["错误", "含义", "处理方式"],
        rows: [
          [
            "claim_conflict",
            "已有别人在处理该卡片",
            "换一张卡片，或请对方重新打开",
          ],
          ["forbidden", "你既不是创建者也不是负责人", "由创建者或负责人来修改"],
          [
            "card_not_found",
            "该编号在看板上不存在",
            "用 ukb board 查看真实的编号",
          ],
          [
            "revision_conflict",
            "卡片自你读取后已发生变化",
            "重新读取（ukb show 或 GET /api/cards/:id）后重试",
          ],
          [
            "invalid_state",
            "该流转不合理（例如认领已完成的卡片）",
            "先确认卡片当前状态",
          ],
          [
            "unauthorized",
            "未携带令牌的变更操作",
            "传入 ukb web 输出的 URL 中的令牌",
          ],
        ],
      },
      {
        t: "p",
        text:
          "智能体：在任意目录下运行 ukb（或 kanban_my_cards）即可——全机只有一块看板，位于 ~/.ukb/，" +
          "所以从哪个目录运行并不重要。用 --project <标识> 过滤以只看某个项目的工作。如果无法解析身份，请传入 --agent <名称>。",
      },
    ],
  },
];

/** The documentation content, exported for tests. */
/** Documentation content, per language. */
export const DOCS = { en: DOCS_EN, zh: DOCS_ZH };

export const DOCS_SECTIONS = DOCS_EN;

/* ------------------------------------------------------------------ *
 * Browser app
 * ------------------------------------------------------------------ */

if (typeof document !== "undefined" && typeof window !== "undefined") {
  startApp();
}

function startApp() {
  const TOKEN = new URLSearchParams(window.location.search).get("token") ?? "";
  const STORAGE_KEY = "using-kanban.actor";
  const LANG_KEY = "using-kanban.lang";
  /** How this keyboard labels the submit chord — spelled in the modal's hint. */
  const SUBMIT_KEY = /mac|iphone|ipad/i.test(navigator.userAgent)
    ? "⌘"
    : "Ctrl";

  const els = {
    board: document.getElementById("board"),
    docs: document.getElementById("docs"),
    events: document.getElementById("events"),
    boardControls: document.getElementById("board-controls"),
    actorName: document.getElementById("actor-name"),
    actorType: document.getElementById("actor-type"),
    filterQ: document.getElementById("filter-q"),
    filters: document.getElementById("filters"),
    filterProject: document.getElementById("filter-project"),
    filterAssignee: document.getElementById("filter-assignee"),
    filterReviewer: document.getElementById("filter-reviewer"),
    live: document.getElementById("live"),
    newCard: document.getElementById("new-card"),
    cardBackdrop: document.getElementById("card-dialog-backdrop"),
    cardDialog: document.getElementById("card-dialog"),
    modalBackdrop: document.getElementById("modal-backdrop"),
    modal: document.getElementById("modal"),
    docBackdrop: document.getElementById("doc-backdrop"),
    docViewer: document.getElementById("doc-viewer"),
    toasts: document.getElementById("toasts"),
  };

  const state = {
    cards: [],
    actor: { name: "me", type: "human" },
    filter: { q: "", project: "", assignee: "", reviewer: "" },
    /** Columns the user has expanded past their collapsed preview. */
    expanded: new Set(),
    openCardId: null,
    dragCardId: null,
    route: currentRoute(),
    lang: loadLanguage(),
    /** Projects in use, for the audit page's filter. Filled by `refresh`. */
    projects: [],
    /** The audit page: a newest-first window over the event log. */
    events: {
      items: [],
      hasMore: false,
      newestId: 0,
      loading: false,
      query: "",
      project: "",
      /** `auto` (fit the window) or a fixed count from EVENT_PAGE_SIZES. */
      pageSize: 25,
      /** The count the current page was fetched with; see `scheduleEventFit`. */
      resolvedSize: null,
      /** Size of the whole filtered log — what the pager counts against.
       *  null when the server did not report one (an older server). */
      total: null,
      page: 0,
      /** The `before` cursor each page was fetched with; page 0 is newest. */
      cursors: [null],
    },
  };

  /** Guards against re-rendering the docs when only the section hash changes. */
  let docsRendered = false;

  /** Translate a key, with optional `{n}` / `{id}` interpolation. */
  function t(key, params) {
    const table = I18N[state.lang] ?? I18N.en;
    const template = table[key] ?? I18N.en[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name)
        ? String(params[name])
        : match,
    );
  }

  function applyLanguage() {
    document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";

    // static markup that is not re-rendered per route
    document.querySelector(".identity label").textContent =
      t("controls.actingAs");
    els.filterQ.placeholder = t("controls.filterPlaceholder");
    els.newCard.textContent = t("controls.newCard");
    els.actorType.options[0].textContent = t("actor.human");
    els.actorType.options[1].textContent = t("actor.agent");
    for (const link of document.querySelectorAll(".nav-link")) {
      link.textContent = t(`nav.${link.dataset.route}`);
    }
    for (const button of document.querySelectorAll(".lang-option")) {
      const active = button.dataset.lang === state.lang;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
    // the card dialog is built from translated labels, so rebuild it if it is open
    const openCardId = state.openCardId;
    if (openCardId !== null) {
      state.openCardId = null;
      void openCardDialog(openCardId);
    }
    render();
    if (state.route === "docs") void renderDocs();
  }

  /** `#/board`, `#/events` or `#/docs` — the docs page is the home page. */
  function currentRoute() {
    const hash = window.location.hash.replace(/^#\/?/, "");
    if (hash.startsWith("board")) return "board";
    if (hash.startsWith("events")) return "events";
    return "docs";
  }

  /** The section targeted by `#/docs/<id>`, if any. */
  function currentSection() {
    const hash = window.location.hash.replace(/^#\/?/, "");
    const match = /^docs\/([\w-]+)$/.exec(hash);
    return match ? match[1] : null;
  }

  function applyRoute() {
    state.route = currentRoute();
    const onDocs = state.route === "docs";
    const onEvents = state.route === "events";

    els.board.hidden = state.route !== "board";
    els.docs.hidden = !onDocs;
    els.events.hidden = !onEvents;
    els.boardControls.hidden = state.route !== "board";

    for (const link of document.querySelectorAll(".nav-link")) {
      const active = link.dataset.route === state.route;
      link.classList.toggle("active", active);
      link.setAttribute("aria-current", active ? "page" : "false");
    }

    if (onEvents) {
      closeCardDialog();
      closeModal();
      void renderEvents();
      return;
    }

    if (!onDocs) {
      void refresh();
      return;
    }

    // Only build the docs once. A section link must scroll, not re-render —
    // re-rendering would reset the scroll position.
    if (!docsRendered) {
      docsRendered = true;
      closeCardDialog();
      closeModal();
      void renderDocs();
      return;
    }
    scrollToSection(currentSection());
  }

  function scrollToSection(sectionId) {
    if (!sectionId) return;
    const target = els.docs.querySelector(`#docs-${sectionId}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    markTocActive(sectionId);
  }

  /** Highlights the table-of-contents entry for the section in view. */
  function markTocActive(sectionId) {
    for (const link of els.docs.querySelectorAll(".docs-toc a")) {
      const active = link.dataset.section === sectionId;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
  }

  /**
   * Scroll-spy via IntersectionObserver: the first section intersecting the
   * top band of the scroll container is the active one. Robust to where a
   * smooth scroll actually lands.
   */
  function watchDocsScroll() {
    const container = els.docs;
    if (!container || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0];
        if (first) markTocActive(first.target.id.replace("docs-", ""));
      },
      { root: container, rootMargin: "-120px 0px -55% 0px", threshold: 0 },
    );

    for (const section of container.querySelectorAll(".docs-section")) {
      observer.observe(section);
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
      let code = "internal_error";
      let message = `${response.status} ${response.statusText}`;
      try {
        const payload = await response.json();
        if (typeof payload?.error?.message === "string")
          message = payload.error.message;
        if (typeof payload?.error?.code === "string") code = payload.error.code;
      } catch {
        // keep the status message
      }
      // The server speaks English; localise the code so the user sees a known
      // label, and keep the server's detail for the specifics.
      const label = t(`error.${code}`);
      throw new Error(label === code ? message : `${label}: ${message}`);
    }
    return response.status === 204 ? null : response.json();
  }

  /* ----------------------------- identity ---------------------------- */

  function loadLanguage() {
    const stored = window.localStorage.getItem(LANG_KEY);
    if (stored === "zh" || stored === "en") return stored;
    // default to the browser's language when it is Chinese
    return (navigator.language ?? "").toLowerCase().startsWith("zh")
      ? "zh"
      : "en";
  }

  function setLanguage(lang) {
    if (lang !== "zh" && lang !== "en") return;
    state.lang = lang;
    window.localStorage.setItem(LANG_KEY, lang);
    applyLanguage();
  }

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
        ...board.someday,
        ...board.todo,
        ...board.doing,
        ...board.review,
        ...board.done,
      ];
      state.projects = board.projects ?? [];
      render();
      // The audit rows carry card titles, and a live event can land before the
      // board it names has arrived — so the row is redrawn once the cards are
      // here, instead of showing a bare `#31` until the next load.
      if (state.route === "events") renderEventList();
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
    source.onmessage = (message) => {
      scheduleRefresh();
      if (state.route !== "events") return;
      // The server backfills the whole log on connect, so only events past the
      // newest one we hold are genuinely new. They belong at the top only on
      // the newest page, and only if they pass the active project filter.
      try {
        const event = JSON.parse(message.data);
        if (
          typeof event?.id !== "number" ||
          event.id <= state.events.newestId
        ) {
          return;
        }
        state.events.newestId = event.id;
        if (!eventInProject(event)) return;
        // The log grew, so the pager's total grows with it — whatever page the
        // reader is on (and only when there is a total to grow).
        if (state.events.total !== null) state.events.total += 1;
        if (state.events.page !== 0) {
          updateEventPager();
          return;
        }
        // ...but the row itself only belongs at the top of the newest page.
        state.events.items = mergeEvents(
          state.events.items,
          [event],
          // The window the page was fetched with — never `pageSize` itself,
          // which is `"auto"` when the reader asked for a screenful.
          state.events.resolvedSize ?? EVENT_PAGE_SIZES[0],
        );
        renderEventList();
      } catch {
        // A frame we cannot parse is not worth breaking the page over.
      }
    };
    source.onerror = () => setLive("offline"); // EventSource reconnects on its own
  }

  function setLive(next) {
    els.live.dataset.state = next;
    els.live.textContent =
      next === "live"
        ? t("live.live")
        : next === "offline"
          ? t("live.offline")
          : t("live.connecting");
  }

  /* ----------------------------- rendering --------------------------- */

  function render() {
    if (state.route !== "board") return;
    renderBoard();
    renderFilterOptions();
    if (state.openCardId !== null) renderCardDialog();
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
      label.textContent = t(`column.${column.id}`);
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(
        visible.filter((card) => card.state === column.id).length,
      );
      header.append(dot, label, count);

      const list = document.createElement("div");
      list.className = "card-list";
      const sorted = sortCards(
        visible.filter((card) => card.state === column.id),
      );
      const preview = previewCards(
        sorted,
        column.id,
        state.expanded.has(column.id),
      );
      const cards = preview.cards;
      if (cards.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = t("column.empty");
        list.append(empty);
      }
      for (const card of cards) {
        list.append(renderCard(card, blocked.has(card.id)));
      }
      if (preview.collapsed) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "column-more";
        more.textContent = t("column.showRest", { n: preview.hidden });
        more.addEventListener("click", () => {
          state.expanded.add(column.id);
          renderBoard();
        });
        list.append(more);
      } else if (
        column.id === "done" &&
        preview.hidden === 0 &&
        sorted.length > DONE_PREVIEW
      ) {
        const fewer = document.createElement("button");
        fewer.type = "button";
        fewer.className = "column-more";
        fewer.textContent = t("column.showLess");
        fewer.addEventListener("click", () => {
          state.expanded.delete(column.id);
          renderBoard();
        });
        list.append(fewer);
      }

      section.append(header, list);
      attachDropTarget(section, column.id);
      els.board.append(section);
    }
  }

  /** Derived progress of an umbrella: done over all of its direct children. */
  function childProgressOf(card) {
    const ids = card.children ?? [];
    const done = ids.filter((id) => {
      const child = state.cards.find((entry) => entry.id === id);
      return child?.state === "done";
    }).length;
    return { total: ids.length, done };
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
    // Only when it is not the default, so the common case stays quiet and the
    // badge means something when it appears.
    if (card.priority && card.priority !== "normal")
      meta.append(
        badge(
          `${t("card.priority")}${t(`priority.${card.priority}`)}`,
          `priority priority-${card.priority}`,
        ),
      );
    if (card.project)
      meta.append(badge(`${t("card.project")}${card.project}`, "project"));
    if (card.reviewer)
      meta.append(badge(`${t("card.reviewer")}${card.reviewer}`, "reviewer"));
    if (blocked) {
      meta.append(
        badge(`${t("card.blockedBy")}${card.blockedBy.join(",")}`, "blocked"),
      );
    }
    if ((card.blocks ?? []).length > 0) {
      meta.append(
        badge(`${t("card.blocks")}${card.blocks.join(",")}`, "downstream"),
      );
    }
    if (card.parent != null) {
      meta.append(badge(`${t("card.parent")}${card.parent}`, "parent"));
    }
    if ((card.children ?? []).length > 0) {
      const progress = childProgressOf(card);
      meta.append(
        badge(
          `${t("card.children")}${progress.done}/${progress.total}`,
          "children",
        ),
      );
    }
    if ((card.notes ?? []).length > 0) {
      meta.append(badge(`${t("card.notes")}${card.notes.length}`, "notes"));
    }
    meta.append(badge(formatRelativeTime(card.updatedAt, Date.now(), t), ""));

    element.append(title, meta);

    element.addEventListener("click", () => openCardDialog(card.id));
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openCardDialog(card.id);
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
      await transition(
        id,
        actionForColumn(column),
        column === "someday" ? { to: "someday" } : {},
      );
    });
  }

  function renderFilterOptions() {
    fillSelect(
      els.filterProject,
      projectOptions(state.cards),
      t("filter.anyProject"),
    );
    fillSelect(
      els.filterAssignee,
      actorOptions(state.cards, "assignee"),
      t("filter.anyAssignee"),
    );
    fillSelect(
      els.filterReviewer,
      actorOptions(state.cards, "reviewer"),
      t("filter.anyReviewer"),
    );
  }

  /** Distinct project slugs in use, sorted — untagged cards are not a project. */
  function projectOptions(cards) {
    const names = new Set();
    for (const card of cards) if (card.project) names.add(card.project);
    return [...names].sort();
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
    state.filter[filterKeyFor(select)] = select.value;
  }

  /** Which filter field a given <select> owns. */
  function filterKeyFor(select) {
    if (select === els.filterProject) return "project";
    if (select === els.filterAssignee) return "assignee";
    return "reviewer";
  }

  /* ----------------------------- mutations --------------------------- */

  async function transition(id, action, body = {}) {
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
      await api(`/api/cards/${id}/${endpoint}`, { method: "POST", body });
      await refresh();
    } catch (error) {
      toast(error.message, "error");
      await refresh(); // the server is the source of truth
    }
  }

  /* ----------------------------- card dialog -------------------------- */

  async function openCardDialog(id) {
    state.openCardId = id;
    els.cardBackdrop.hidden = false;
    els.cardDialog.hidden = false;
    await renderCardDialog();
  }

  function closeCardDialog() {
    state.openCardId = null;
    els.cardBackdrop.hidden = true;
    els.cardDialog.hidden = true;
    els.cardDialog.textContent = "";
  }

  async function renderCardDialog() {
    const id = state.openCardId;
    if (id === null) return;
    let card = state.cards.find((entry) => entry.id === id);
    if (!card) {
      try {
        const payload = await api(`/api/cards/${id}`);
        card = payload.card;
      } catch {
        closeCardDialog();
        return;
      }
    }

    els.cardDialog.textContent = "";

    const header = document.createElement("div");
    header.className = "dialog-head";
    const heading = document.createElement("h2");
    heading.textContent = `#${card.id} ${card.title}`;
    const pill = document.createElement("span");
    pill.className = "state-pill";
    pill.textContent = t(`column.${card.state}`);
    const close = document.createElement("button");
    close.className = "icon-button";
    close.type = "button";
    close.textContent = "✕";
    close.setAttribute("aria-label", t("drawer.close"));
    close.addEventListener("click", closeCardDialog);
    header.append(heading, pill, close);

    const body = document.createElement("div");
    body.className = "dialog-body";

    // Two columns: what the card *is* on the left, how it connects on the
    // right. A panel this wide with one column would stretch every input to
    // half a metre.
    const columns = document.createElement("div");
    columns.className = "dialog-columns";
    const main = document.createElement("div");
    main.className = "dialog-main";
    const side = document.createElement("div");
    side.className = "dialog-side";
    columns.append(main, side);
    body.append(columns);

    // editable fields
    main.append(
      field(
        t("drawer.title"),
        textInput(card.title, async (value) => {
          await saveCard(id, { title: value });
        }),
      ),
      field(
        t("drawer.body"),
        textArea(card.body ?? "", async (value) => {
          await saveCard(id, { body: value });
        }),
      ),
    );

    const fields = document.createElement("div");
    fields.className = "row";
    fields.append(
      field(
        t("drawer.assignee"),
        textInput(card.assignee ?? "", async (value) => {
          await saveCard(id, { assignee: value });
        }),
      ),
      field(
        t("drawer.reviewer"),
        textInput(card.reviewer ?? "", async (value) => {
          await saveCard(id, { reviewer: value });
        }),
      ),
      field(
        t("drawer.project"),
        projectPicker(card.project ?? "", async (value) => {
          // "no project" is not the empty string — the API spells it null.
          await saveCard(id, { project: value || null });
        }).element,
      ),
      field(
        t("drawer.priority"),
        selectInput(
          card.priority ?? "normal",
          PRIORITY_OPTIONS.map((value) => ({
            value,
            label: t(`priority.${value}`),
          })),
          async (value) => {
            await saveCard(id, { priority: value });
          },
        ),
      ),
    );
    main.append(fields, notesField(card));

    // The transitions live in the footer, next to the one destructive action —
    // the same shape the new-card modal's footer uses.
    const actions = document.createElement("div");
    actions.className = "actions";
    for (const [labelKey, action, enabled, actionBody] of [
      [
        "drawer.claim",
        "claim",
        card.state === "todo" || card.state === "someday",
        undefined,
      ],
      [
        "drawer.requestReview",
        "review",
        card.state !== "done" && card.state !== "review",
        undefined,
      ],
      ["drawer.done", "done", card.state !== "done", undefined],
      ["drawer.reopen", "reopen", card.state !== "todo", undefined],
      ["drawer.someday", "move", card.state !== "someday", { to: "someday" }],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = t(labelKey);
      button.disabled = !enabled;
      button.addEventListener(
        "click",
        () => void transition(id, action, actionBody),
      );
      actions.append(button);
    }

    side.append(hierarchyField(card));

    // relations — one edge, shown from both ends
    side.append(
      relationField(
        card,
        "blockedBy",
        t("drawer.blockedBy"),
        t("drawer.addUpstream"),
      ),
      relationField(
        card,
        "blocks",
        t("drawer.blocks"),
        t("drawer.addDownstream"),
      ),
    );

    // history — best-effort, and filled in after the panel is on screen so a
    // slow read never delays opening a card
    const historyField = field(t("drawer.history"));
    const historyList = document.createElement("ul");
    historyList.className = "history";
    historyField.append(historyList);
    side.append(historyField);

    // delete
    const danger = document.createElement("div");
    danger.className = "actions";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = t("drawer.delete");
    del.addEventListener("click", async () => {
      if (!window.confirm(t("drawer.confirmDelete", { id }))) return;
      try {
        await api(`/api/cards/${id}`, { method: "DELETE" });
        toast(`deleted #${id}`);
        closeCardDialog();
        await refresh();
      } catch (error) {
        toast(error.message, "error");
      }
    });
    danger.append(del);

    const foot = document.createElement("div");
    foot.className = "dialog-foot";
    foot.append(danger, actions);

    els.cardDialog.append(header, body, foot);
    void fillHistory(historyList, id);
  }

  /** The card's history, appended to a list that is already on screen. */
  async function fillHistory(list, id) {
    try {
      const payload = await api(`/api/cards/${id}/history`);
      for (const event of payload.events) {
        const item = document.createElement("li");
        const who = document.createElement("span");
        who.className = "who";
        who.textContent = `${event.actor.type}/${event.actor.name}`;
        const what = document.createElement("span");
        what.textContent = `${describeEvent(event)} · ${formatRelativeTime(event.ts, Date.now(), t)}`;
        item.append(who, what);
        list.append(item);
      }
    } catch {
      // history is best-effort
    }
  }

  /**
   * One end of the relation graph. `side` is the card field holding the ids:
   * `blockedBy` is upstream (this card waits on them), `blocks` is downstream
   * (they wait on this card). Adding from either side writes the same edge.
   */
  /** The umbrella this card belongs to, and the parts it is composed of. */
  function hierarchyField(card) {
    const wrapper = field(t("drawer.hierarchy"));
    const chips = document.createElement("div");
    chips.className = "blockers";

    if (card.parent != null) {
      const parent = state.cards.find((entry) => entry.id === card.parent);
      const chip = document.createElement("span");
      chip.className = "badge relation";
      chip.textContent = `⤷ #${card.parent}${parent ? ` ${parent.title} (${parent.state})` : ""}`;
      chip.title = parent?.title ?? `#${card.parent}`;
      chip.addEventListener("click", () => void openCardDialog(card.parent));
      const detach = document.createElement("button");
      detach.className = "icon-button";
      detach.type = "button";
      detach.textContent = "✕";
      detach.setAttribute(
        "aria-label",
        t("drawer.unparent", { id: card.parent }),
      );
      detach.addEventListener("click", async (event) => {
        event.stopPropagation();
        try {
          await api(`/api/cards/${card.id}/unparent`, {
            method: "POST",
            body: {},
          });
          await refresh();
        } catch (error) {
          toast(error.message, "error");
        }
      });
      chip.append(detach);
      chips.append(chip);
    } else if ((card.children ?? []).length === 0) {
      // A card with children is an umbrella and cannot gain a parent; a
      // standalone card may go either way.
      const input = document.createElement("input");
      input.type = "number";
      input.min = "1";
      input.placeholder = t("drawer.setParent");
      const set = document.createElement("button");
      set.type = "button";
      set.textContent = t("drawer.parent");
      set.addEventListener("click", async () => {
        const parent = Number(input.value);
        if (!Number.isInteger(parent) || parent <= 0) {
          toast(t("modal.enterId"), "error");
          return;
        }
        try {
          await api(`/api/cards/${card.id}/parent`, {
            method: "POST",
            body: { parent },
          });
          input.value = "";
          await refresh();
        } catch (error) {
          toast(error.message, "error");
        }
      });
      chips.append(input, set);
    }

    const children = (card.children ?? [])
      .map((id) => state.cards.find((entry) => entry.id === id))
      .filter(Boolean);
    if (children.length > 0) {
      const done = children.filter((child) => child.state === "done").length;
      const progress = document.createElement("span");
      progress.className = "badge";
      progress.textContent = t("drawer.childProgress", {
        done,
        total: children.length,
      });
      chips.append(progress);
      for (const child of children) {
        const chip = document.createElement("span");
        chip.className = "badge relation";
        chip.textContent = `#${child.id} [${child.state}] ${child.title}`;
        chip.title = child.title;
        chip.addEventListener("click", () => void openCardDialog(child.id));
        chips.append(chip);
      }
    }

    if (card.parent == null) {
      const childInput = document.createElement("input");
      childInput.type = "number";
      childInput.min = "1";
      childInput.placeholder = t("drawer.addChild");
      const addChild = document.createElement("button");
      addChild.type = "button";
      addChild.textContent = t("drawer.addChildButton");
      addChild.addEventListener("click", async () => {
        const child = Number(childInput.value);
        if (!Number.isInteger(child) || child <= 0) {
          toast(t("modal.enterId"), "error");
          return;
        }
        try {
          // Attaching changes the child card, so the call is addressed to it.
          await api(`/api/cards/${child}/parent`, {
            method: "POST",
            body: { parent: card.id },
          });
          childInput.value = "";
          await refresh();
        } catch (error) {
          toast(error.message, "error");
        }
      });
      chips.append(childInput, addChild);
    }

    wrapper.append(chips);
    return wrapper;
  }

  function relationField(card, side, label, placeholder) {
    const wrapper = field(label);
    const chips = document.createElement("div");
    chips.className = "blockers";

    const ids = card[side] ?? [];
    if (ids.length === 0) {
      const none = document.createElement("span");
      none.className = "badge";
      none.textContent = t("drawer.none");
      chips.append(none);
    }

    for (const otherId of ids) {
      const other = state.cards.find((entry) => entry.id === otherId);
      const chip = document.createElement("span");
      chip.className = "badge relation";
      chip.textContent = `#${otherId}${other ? ` ${other.title} (${other.state})` : ""}`;
      chip.title = other?.title ?? `#${otherId}`;
      chip.addEventListener("click", () => void openCardDialog(otherId));
      const remove = document.createElement("button");
      remove.className = "icon-button";
      remove.type = "button";
      remove.textContent = "✕";
      remove.setAttribute("aria-label", t("drawer.unrelate", { id: otherId }));
      remove.addEventListener("click", async (event) => {
        event.stopPropagation();
        try {
          await api(`/api/cards/${card.id}/unrelate`, {
            method: "POST",
            body: { other: otherId },
          });
          await refresh();
        } catch (error) {
          toast(error.message, "error");
        }
      });
      chip.append(remove);
      chips.append(chip);
    }

    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.placeholder = placeholder;
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = t("drawer.relate");
    add.addEventListener("click", async () => {
      const other = Number(input.value);
      if (!Number.isInteger(other) || other <= 0) {
        toast(t("modal.enterId"), "error");
        return;
      }
      try {
        await api(`/api/cards/${card.id}/relate`, {
          method: "POST",
          body: {
            other,
            direction: side === "blocks" ? "downstream" : "upstream",
          },
        });
        input.value = "";
        await refresh();
      } catch (error) {
        toast(error.message, "error");
      }
    });
    chips.append(input, add);
    wrapper.append(chips);
    return wrapper;
  }

  /** Remarks and the documents they link to. */
  function notesField(card) {
    const wrapper = field(t("drawer.notes"));
    const list = document.createElement("div");
    list.className = "notes";

    const notes = card.notes ?? [];
    if (notes.length === 0) {
      const none = document.createElement("span");
      none.className = "badge";
      none.textContent = t("drawer.noNotes");
      list.append(none);
    }

    for (const note of notes) {
      const item = document.createElement("div");
      item.className = "note";

      const text = document.createElement("div");
      text.className = "note-text";
      text.textContent = note.text;
      item.append(text);

      if (note.url) {
        const kind = docKindOf(note.url);
        const link = document.createElement("button");
        link.type = "button";
        link.className = "note-link";
        link.textContent = note.url;
        link.title = kind === "link" ? t("doc.newTab") : t("drawer.openDoc");
        link.addEventListener("click", () => {
          if (kind === "link") {
            window.open(note.url, "_blank", "noreferrer");
            return;
          }
          void openDoc(note.url);
        });
        item.append(link);
      }

      const meta = document.createElement("span");
      meta.className = "note-meta";
      meta.textContent = `${note.createdBy} · ${formatRelativeTime(note.createdAt, Date.now(), t)}`;
      item.append(meta);

      const remove = document.createElement("button");
      remove.className = "icon-button";
      remove.type = "button";
      remove.textContent = "✕";
      remove.setAttribute(
        "aria-label",
        t("drawer.removeNote", { id: note.id }),
      );
      remove.addEventListener("click", async () => {
        try {
          await api(`/api/cards/${card.id}/notes/${note.id}`, {
            method: "DELETE",
          });
          await refresh();
        } catch (error) {
          toast(error.message, "error");
        }
      });
      item.append(remove);
      list.append(item);
    }

    const noteText = document.createElement("input");
    noteText.type = "text";
    noteText.placeholder = t("drawer.noteText");
    const noteUrl = document.createElement("input");
    noteUrl.type = "text";
    noteUrl.placeholder = t("drawer.noteUrl");
    const add = document.createElement("button");
    add.type = "button";
    add.className = "secondary";
    add.textContent = t("drawer.addNote");
    add.addEventListener("click", async () => {
      const text = noteText.value.trim();
      if (!text) {
        toast(t("drawer.needsText"), "error");
        return;
      }
      try {
        await api(`/api/cards/${card.id}/notes`, {
          method: "POST",
          body: { text, url: noteUrl.value.trim() || null },
        });
        noteText.value = "";
        noteUrl.value = "";
        await refresh();
      } catch (error) {
        toast(error.message, "error");
      }
    });
    list.append(noteText, noteUrl, add);
    wrapper.append(list);
    return wrapper;
  }

  /* ----------------------------- documents ---------------------------- */

  /** Reads a note's document from the server and shows it in place. */
  async function openDoc(url) {
    els.docBackdrop.hidden = false;
    els.docViewer.hidden = false;
    docShell(url);
    try {
      const payload = await api(`/api/doc?path=${encodeURIComponent(url)}`);
      renderDoc(payload);
    } catch (error) {
      docFailure(error.message);
    }
  }

  function closeDoc() {
    els.docBackdrop.hidden = true;
    els.docViewer.hidden = true;
    els.docViewer.textContent = "";
  }

  function docShell(url) {
    els.docViewer.textContent = "";
    const header = document.createElement("div");
    header.className = "doc-header";
    const title = document.createElement("h2");
    title.textContent = url;
    const close = document.createElement("button");
    close.className = "icon-button";
    close.type = "button";
    close.textContent = "✕";
    close.setAttribute("aria-label", t("doc.close"));
    close.addEventListener("click", closeDoc);
    header.append(title, close);

    const hint = document.createElement("p");
    hint.className = "doc-hint";
    hint.textContent = t("doc.hint");

    const body = document.createElement("div");
    body.className = "doc-body";
    const loading = document.createElement("p");
    loading.textContent = t("doc.loading");
    body.append(loading);

    els.docViewer.append(header, hint, body);
  }

  function docFailure(message) {
    const body = els.docViewer.querySelector(".doc-body");
    if (!body) return;
    body.textContent = "";
    const failed = document.createElement("p");
    failed.className = "doc-failed";
    failed.textContent = `${t("doc.failed")} — ${message}`;
    body.append(failed);
  }

  function renderDoc(doc) {
    const body = els.docViewer.querySelector(".doc-body");
    if (!body) return;
    body.textContent = "";

    if (doc.kind === "html") {
      // Sandboxed: the document is content, never code running in this origin.
      const frame = document.createElement("iframe");
      frame.className = "doc-frame";
      frame.setAttribute("sandbox", "");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.srcdoc = rewriteDocRefs(doc.content ?? "", doc.path);
      body.append(frame);
      return;
    }

    if (doc.kind === "markdown") {
      const article = document.createElement("article");
      article.className = "markdown";
      article.innerHTML = markdownToHtml(doc.content ?? "", {
        resolveHref: (href) => resolveDocRef(href, doc.path),
        resolveSrc: (src) => resolveDocRef(src, doc.path),
      });
      body.append(article);
      return;
    }

    const pre = document.createElement("pre");
    pre.className = "doc-text";
    pre.textContent = doc.content ?? "";
    body.append(pre);
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

  /**
   * The project control: a dropdown of the slugs in use, so nobody has to
   * remember one, with an escape hatch for a slug the board has not seen yet.
   *
   * It hands back the control and a `value()` reader rather than just the node,
   * because a form can be submitted without any change event firing — ⌘↵ on a
   * slug typed a moment ago, say — and the caller still has to know the answer.
   */
  function projectPicker(value, onChange) {
    const NEW = "__new";
    const slugs = state.projects;

    const select = document.createElement("select");
    select.setAttribute("aria-label", t("drawer.project"));
    const none = document.createElement("option");
    none.value = "";
    none.textContent = t("modal.noProject");
    select.append(none);
    for (const slug of slugs) {
      const option = document.createElement("option");
      option.value = slug;
      option.textContent = slug;
      select.append(option);
    }
    const fresh = document.createElement("option");
    fresh.value = NEW;
    fresh.textContent = t("modal.newProject");
    select.append(fresh);
    select.value = slugs.includes(value) ? value : "";

    const typed = textInput(value, (next) => onChange(next.trim()));
    typed.placeholder = t("modal.projectPlaceholder");
    typed.autocomplete = "off";
    typed.spellcheck = false;

    const back = document.createElement("button");
    back.type = "button";
    back.className = "icon-button";
    back.textContent = "←";
    back.setAttribute("aria-label", t("modal.back"));

    const typer = document.createElement("div");
    typer.className = "project-typer";
    typer.hidden = true;
    typer.append(typed, back);

    select.addEventListener("change", () => {
      if (select.value !== NEW) {
        onChange(select.value);
        return;
      }
      // A slug the board has not seen yet: trade the list for a text box.
      select.hidden = true;
      typer.hidden = false;
      typed.value = "";
      typed.focus();
    });

    back.addEventListener("click", () => {
      typer.hidden = true;
      select.hidden = false;
      select.value = slugs.includes(value) ? value : "";
      select.focus();
    });

    const element = document.createElement("div");
    element.className = "project-picker";
    element.append(select, typer);
    return {
      element,
      value: () => (typer.hidden ? select.value : typed.value),
    };
  }

  async function openModal() {
    // The project dropdown lists the slugs in use, and only the board response
    // knows them. The button lives on the board, so they are normally loaded
    // already; this covers a cold open that lands straight on #/board.
    if (state.projects.length === 0) await refresh();

    els.modal.textContent = "";

    const head = document.createElement("div");
    head.className = "modal-head";
    const heading = document.createElement("h2");
    heading.textContent = t("modal.newCard");
    const hint = document.createElement("p");
    hint.className = "modal-hint";
    hint.textContent = t("modal.hint");
    head.append(heading, hint);

    const title = textInput("", () => {});
    const bodyInput = textArea("", () => {});
    const assignee = textInput(state.actor.name, () => {});
    const reviewer = textInput("", () => {});
    const project = projectPicker("", () => {});
    const priority = selectInput(
      "normal",
      PRIORITY_OPTIONS.map((value) => ({
        value,
        label: t(`priority.${value}`),
      })),
      () => {},
    );

    const row = document.createElement("div");
    row.className = "row";
    row.append(
      field(t("drawer.assignee"), assignee),
      field(t("drawer.reviewer"), reviewer),
      field(t("drawer.project"), project.element),
      field(t("drawer.priority"), priority),
    );

    const form = document.createElement("div");
    form.className = "dialog-body";
    form.append(
      field(t("drawer.title"), title),
      field(t("modal.body"), bodyInput),
      row,
    );

    const submit = async () => {
      if (!title.value.trim()) {
        toast(t("modal.needsTitle"), "error");
        title.focus();
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
            // No project is not a project: the field stays unset rather than
            // becoming the empty string, which the schema rejects.
            project: project.value() || undefined,
            priority: priority.value,
          },
        });
        closeModal();
        await refresh();
      } catch (error) {
        toast(error.message, "error");
      }
    };

    // The chord saves without reaching for the mouse, and a select swallows
    // Enter to cycle its options — so only the modifier counts as a submit.
    form.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void submit();
      }
    });

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const submitHint = document.createElement("span");
    submitHint.className = "modal-submit-hint";
    submitHint.textContent = t("modal.submitHint", { key: SUBMIT_KEY });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = t("modal.cancel");
    cancel.addEventListener("click", closeModal);
    const create = document.createElement("button");
    create.type = "button";
    create.className = "primary";
    create.textContent = t("modal.create");
    create.addEventListener("click", () => void submit());
    actions.append(submitHint, cancel, create);

    els.modal.append(head, form, actions);
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
    for (const section of DOCS[state.lang] ?? DOCS.en) {
      const link = document.createElement("a");
      link.href = `#/docs/${section.id}`;
      link.textContent = section.title;
      link.dataset.section = section.id;
      toc.append(link);
    }

    const article = document.createElement("article");
    article.className = "docs-body";
    for (const section of DOCS[state.lang] ?? DOCS.en) {
      article.append(renderDocsSection(section));
    }

    layout.append(toc, article);
    els.docs.textContent = "";
    els.docs.append(hero, layout);

    // arriving at a specific section scrolls to it; otherwise start at the top
    const target = currentSection();
    if (target) {
      requestAnimationFrame(() => scrollToSection(target));
    } else {
      els.docs.scrollTop = 0;
    }
    watchDocsScroll();

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

  /* ------------------------------- events ------------------------------ */

  /** Page sizes the audit view offers. Paging is by event-id cursor. */
  const EVENT_PAGE_SIZES = [25, 50, 100, 200];
  /**
   * A row's design height, for `auto`.
   *
   * A constant rather than a measurement on purpose: measuring a rendered row
   * makes `auto` chase its own tail — a page whose rows wrapped measures
   * taller, so the next page is smaller, so those rows may not wrap. A row only
   * wraps on a narrow window, and there the list scrolling a little is the
   * honest outcome. Kept in step with `.event-row` in style.css.
   */
  const EVENT_ROW_HEIGHT = 42;
  /**
   * Room below the last row: the bottom pager with its margins, the page's own
   * bottom padding (see `.events` in style.css), and a little air. Reserving the
   * whole stack is what makes an auto-sized page one screen with nothing to
   * scroll — pager included.
   */
  const EVENT_PAGE_BOTTOM_GAP = 126;
  let eventsListEl = null;
  /** Every per-page select on screen — one per pager — kept in step. */
  let eventsSizeSelects = [];
  /** Every pager on screen (top and bottom), kept in step by `updateEventPager`. */
  let eventsPagers = [];
  /** Debounce for `auto` following a window resize. */
  let eventsFitTimer = null;

  /** Build the Events page shell (once) and load its first page. */
  async function renderEvents() {
    // Titles and the project list come from the board, which the docs route
    // (the home page) never loads.
    if (state.projects.length === 0) await refresh();
    els.events.textContent = "";

    const header = document.createElement("div");
    header.className = "events-header";
    const title = document.createElement("h1");
    title.textContent = t("events.title");
    const controls = document.createElement("div");
    controls.className = "events-controls";
    header.append(title, controls);

    eventsListEl = document.createElement("ul");
    eventsListEl.className = "event-list";

    // The head is a sibling of the list, not a row inside it: `renderEventList`
    // clears the list wholesale, and the fit measurement wants the chrome above
    // the rows counted where it actually sits.
    const panel = document.createElement("div");
    panel.className = "event-panel";
    panel.append(eventHead(), eventsListEl);

    // A pager above and below the list: landing puts one in reach, and finishing
    // a page puts the next step in reach without scrolling all the way back. The
    // per-page control rides with them — that is the paging it governs.
    eventsPagers = [];
    eventsSizeSelects = [];
    els.events.append(header, buildPager(), panel, buildPager());

    controls.append(projectSelect(), queryInput(), refreshButton());
    // Same task as the markup above, so the `auto` label never paints a guess.
    syncPageSizeSelects();
    await loadEvents();
  }

  /** The column labels — what makes the list read as a table. */
  function eventHead() {
    const head = document.createElement("div");
    head.className = "event-head";
    // The rows speak for themselves; the labels are for the eye, not the reader.
    head.setAttribute("aria-hidden", "true");
    for (const key of [
      "events.colTime",
      "events.colProject",
      "events.colCard",
      "events.colEvent",
      "events.colActor",
      "events.colSource",
    ]) {
      const cell = document.createElement("span");
      cell.textContent = t(key);
      head.append(cell);
    }
    return head;
  }

  /**
   * How many rows fit between the top of the list and the bottom of the window.
   *
   * Measured from the live layout rather than assumed: the chrome above the list
   * (topbar, heading, controls, pager, head row) is what `auto` is about, and it
   * is the browser that knows how tall it came out. Adding the page's scroll
   * offset keeps the answer the same whether or not the reader has scrolled.
   */
  function autoPageSize() {
    if (!eventsListEl) return EVENT_PAGE_SIZES[0];
    const top = eventsListEl.getBoundingClientRect().top + els.events.scrollTop;
    return fitPageSize(
      window.innerHeight - top - EVENT_PAGE_BOTTOM_GAP,
      EVENT_ROW_HEIGHT,
    );
  }

  /** The limit this load asks for: `auto` resolves now, a number is already one. */
  function effectivePageSize() {
    return state.events.pageSize === "auto"
      ? autoPageSize()
      : Number(state.events.pageSize);
  }

  /**
   * `auto` follows the window; a fixed choice does not.
   *
   * Debounced, and it refetches only when the count actually moved: a resize
   * drag fires hundreds of events, and each one would be a page-0 reload.
   */
  function scheduleEventFit() {
    if (state.events.pageSize !== "auto") return;
    clearTimeout(eventsFitTimer);
    eventsFitTimer = setTimeout(() => {
      if (autoPageSize() === state.events.resolvedSize) {
        syncPageSizeSelects();
        return;
      }
      resetEventPaging();
      void loadEvents();
    }, 200);
  }

  /**
   * One pager bar — Newer · position · Older, with the row budget beside them.
   *
   * Built twice (above and below the list), so the size control exists twice
   * too; `syncPageSizeSelects` is what keeps the copies in step.
   */
  function buildPager() {
    const pager = document.createElement("div");
    pager.className = "event-pager";

    const nav = document.createElement("div");
    nav.className = "event-pager-nav";
    const newer = document.createElement("button");
    newer.type = "button";
    newer.className = "secondary";
    newer.textContent = `‹ ${t("events.newer")}`;
    newer.addEventListener("click", newerPage);
    const position = document.createElement("span");
    position.className = "event-position";
    const older = document.createElement("button");
    older.type = "button";
    older.className = "secondary";
    older.textContent = `${t("events.older")} ›`;
    older.addEventListener("click", olderPage);
    nav.append(newer, position, older);

    pager.append(nav, pageSizeSelect());
    eventsPagers.push({ newer, older, position });
    return pager;
  }

  /** The project filter: "all projects", then every slug in use. */
  function projectSelect() {
    const select = document.createElement("select");
    select.className = "events-project";
    select.setAttribute("aria-label", t("events.project"));
    const any = document.createElement("option");
    any.value = "";
    any.textContent = t("events.anyProject");
    select.append(any);
    for (const slug of state.projects) {
      const option = document.createElement("option");
      option.value = slug;
      option.textContent = slug;
      select.append(option);
    }
    select.value = state.events.project;
    select.addEventListener("change", () => {
      state.events.project = select.value;
      resetEventPaging();
      void loadEvents();
    });
    return select;
  }

  function queryInput() {
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = t("events.filterPlaceholder");
    input.value = state.events.query;
    // Free text is a find *within* the page: the server filters by project, the
    // browser narrows what it already holds. No refetch, so typing stays cheap.
    input.addEventListener("input", () => {
      state.events.query = input.value;
      renderEventList();
    });
    return input;
  }

  function pageSizeSelect() {
    const select = document.createElement("select");
    select.className = "events-size";
    select.setAttribute("aria-label", t("events.perPage"));
    // Fixed sizes first: 25 is the default, and a reader who wants a screenful
    // instead picks `auto`, which names the count it resolved to.
    for (const size of EVENT_PAGE_SIZES) {
      const option = document.createElement("option");
      option.value = String(size);
      option.textContent = t("events.perPageOption", { n: size });
      select.append(option);
    }
    const auto = document.createElement("option");
    auto.value = "auto";
    auto.textContent = t("events.perPageAuto", { n: autoPageSize() });
    select.append(auto);
    select.value = String(state.events.pageSize);
    eventsSizeSelects.push(select);
    select.addEventListener("change", () => {
      state.events.pageSize =
        select.value === "auto" ? "auto" : Number(select.value);
      syncPageSizeSelects();
      resetEventPaging();
      void loadEvents();
    });
    return select;
  }

  /**
   * Keep every per-page select in step — same value, and an `auto` option that
   * names the count it resolved to. Choosing a size on one pager must visibly
   * choose it on the other, or the two bars disagree about the page you are on.
   */
  function syncPageSizeSelects() {
    for (const select of eventsSizeSelects) {
      select.value = String(state.events.pageSize);
      const auto = select.querySelector('option[value="auto"]');
      if (auto)
        auto.textContent = t("events.perPageAuto", { n: autoPageSize() });
    }
  }

  /**
   * Refresh, as an icon: the header already carries a dropdown and a search box,
   * and a re-read is a glyph everyone recognises. The name is not lost — it
   * lives in `aria-label`/`title`, so this is still a button, not a mystery.
   */
  function refreshButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary icon-only";
    button.setAttribute("aria-label", t("events.refresh"));
    button.title = t("events.refresh");
    button.innerHTML = REFRESH_ICON;
    button.addEventListener("click", () => void loadEvents());
    return button;
  }

  /** Fetch the page `state.events.page` names and repaint. */
  async function loadEvents() {
    if (state.events.loading) return;
    state.events.loading = true;
    const before = state.events.cursors[state.events.page] ?? null;
    const limit = effectivePageSize();
    state.events.resolvedSize = limit;
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (before !== null) params.set("before", String(before));
      if (state.events.project) params.set("project", state.events.project);
      const payload = await api(`/api/log?${params}`);
      state.events.items = payload.events ?? [];
      state.events.hasMore = Boolean(payload.hasMore);
      state.events.total =
        typeof payload.total === "number" ? payload.total : null;
      state.events.newestId = state.events.items[0]?.id ?? 0;
      renderEventList();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      state.events.loading = false;
      updateEventPager();
    }
  }

  function resetEventPaging() {
    state.events.page = 0;
    state.events.cursors = [null];
  }

  /** Step one page older: the cursor is the oldest id on the current page. */
  function olderPage() {
    if (!state.events.hasMore || state.events.loading) return;
    const oldest = state.events.items.at(-1)?.id;
    if (oldest === undefined) return;
    state.events.page += 1;
    state.events.cursors[state.events.page] = oldest;
    void loadEvents();
  }

  function newerPage() {
    if (state.events.page === 0 || state.events.loading) return;
    state.events.page -= 1;
    void loadEvents();
  }

  /** Whether a live event would pass the active project filter. */
  function eventInProject(event) {
    if (!state.events.project) return true;
    return eventProject(event) === state.events.project;
  }

  /**
   * An event's project: the one the server attributed, or the card's own when
   * the row arrived over SSE (where there is no attribution to read).
   */
  function eventProject(event) {
    if (typeof event.project === "string") return event.project;
    return (
      state.cards.find((card) => card.id === event.cardId)?.project ?? null
    );
  }

  function updateEventPager() {
    const n = state.events.page + 1;
    const count = state.events.items.length;
    // "of 25" when the page *is* the whole log reads like a bug, so a server
    // that does not report a total gets the count on its own.
    const label =
      state.events.total === null
        ? t("events.pageNoTotal", { n, count })
        : t("events.page", { n, count, total: state.events.total });
    for (const { newer, older, position } of eventsPagers) {
      newer.disabled = state.events.loading || state.events.page === 0;
      older.disabled = state.events.loading || !state.events.hasMore;
      position.textContent = label;
    }
    syncPageSizeSelects();
  }

  function renderEventList() {
    if (!eventsListEl) return;
    const byId = new Map(state.cards.map((card) => [card.id, card]));
    const query = state.events.query.trim().toLowerCase();
    const shown = state.events.items.filter((event) =>
      matchesEvent(event, query, byId),
    );
    eventsListEl.textContent = "";
    for (const event of shown) eventsListEl.append(eventRow(event, byId));
    if (shown.length === 0) {
      const empty = document.createElement("li");
      empty.className = "event-empty";
      empty.textContent = t("events.empty");
      eventsListEl.append(empty);
    }
    updateEventPager();
  }

  /** One audit row: when, who, through what, what happened, which card. */
  /**
   * One audit row, in the order the head reads: when, which project, which
   * card, what happened, who, through which door. The project is not on the
   * event — it lives on the card, so a card that has since been deleted reads
   * as a dash rather than as belonging to nothing.
   */
  function eventRow(event, byId) {
    const row = document.createElement("li");
    row.className = "event-row";
    row.dataset.type = event.type;

    const card = byId.get(event.cardId);

    const time = document.createElement("time");
    time.className = "event-time";
    time.dateTime = event.ts;
    time.textContent = formatTimestamp(event.ts);

    const project = document.createElement("span");
    project.className = "event-project";
    project.textContent = eventProject(event) ?? "—";
    project.title = project.textContent;

    const ref = document.createElement("button");
    ref.type = "button";
    ref.className = "event-card";
    ref.textContent = `#${event.cardId}${card?.title ? ` ${card.title}` : ""}`;
    ref.addEventListener("click", () => void openCardDialog(event.cardId));

    const desc = document.createElement("span");
    desc.className = "event-desc";
    desc.textContent = describeEvent(event);

    const actor = document.createElement("span");
    actor.className = `event-actor ${event.actor.type}`;
    actor.textContent = `${event.actor.type}/${event.actor.name}`;

    const source = document.createElement("span");
    source.className = "event-source";
    source.textContent = event.source;

    row.append(time, project, ref, desc, actor, source);
    return row;
  }

  /** `YYYY-MM-DD HH:mm:ss` in the reader's timezone. */
  function formatTimestamp(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const pad = (value) => String(value).padStart(2, "0");
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
  }

  /* ------------------------------- wiring ---------------------------- */

  els.newCard.addEventListener("click", () => void openModal());
  for (const button of document.querySelectorAll(".lang-option")) {
    button.addEventListener("click", () => setLanguage(button.dataset.lang));
  }
  els.cardBackdrop.addEventListener("click", closeCardDialog);
  els.modalBackdrop.addEventListener("click", closeModal);
  els.docBackdrop.addEventListener("click", closeDoc);
  // Auto-sized audit pages follow the window; a fixed choice ignores it.
  window.addEventListener("resize", scheduleEventFit);
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
  els.filterProject.addEventListener("change", () => {
    state.filter.project = els.filterProject.value;
    renderBoard();
  });
  els.filterReviewer.addEventListener("change", () => {
    state.filter.reviewer = els.filterReviewer.value;
    renderBoard();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // The document viewer sits on top of the card dialog, so Escape peels one layer:
    // closing both at once loses the card the reader came from.
    if (!els.docViewer.hidden) {
      closeDoc();
      return;
    }
    closeCardDialog();
    closeModal();
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
  applyLanguage();
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

/** A dropdown. Used where the value is a closed set, like priority. */
function selectInput(value, options, onChange) {
  const select = document.createElement("select");
  for (const option of options) {
    const element = document.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    element.selected = option.value === value;
    select.append(element);
  }
  select.addEventListener("change", () => onChange(select.value));
  return select;
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

/**
 * One line saying what an event did. Pure and exported so the card dialog's
 * and the Events page say the same thing, and so it can be tested without a
 * browser. Covers every `EventType`; the fallback is the raw type, which is
 * still true, just not friendly.
 */
export function describeEvent(event) {
  const payload = event.payload ?? {};
  switch (event.type) {
    case "card.created":
      return "created";
    case "card.updated":
      return "edited";
    case "card.moved":
      return `${payload.action ?? "moved"} ${payload.from ?? "?"}→${payload.to ?? "?"}`;
    case "card.deleted":
      return "deleted";
    case "card.dependency_added":
      return `blocked on #${payload.blockedBy ?? "?"}`;
    case "card.dependency_removed":
      return `unblocked from #${payload.blockedBy ?? "?"}`;
    case "card.parent_set":
      return `child of #${payload.parent ?? "?"}`;
    case "card.parent_cleared":
      return "detached from its parent";
    case "card.note_added":
      return "added a note";
    case "card.note_updated":
      return `edited note #${payload.note ?? "?"}`;
    case "card.note_removed":
      return `removed note #${payload.note ?? "?"}`;
    default:
      return event.type;
  }
}

/** How few rows an auto-sized audit page will settle for. */
export const EVENT_MIN_PAGE_SIZE = 5;

/**
 * The refresh glyph: an open circle with an arrowhead, drawn in the same 24-box
 * and with the same stroke as the rest of the UI's line work. Inline rather than
 * a file because the UI ships as one self-contained page with no assets.
 */
const REFRESH_ICON =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="21 3 21 9 15 9" />' +
  '<path d="M20.49 15a9 9 0 1 1-2.12-9.36L21 9" />' +
  "</svg>";

/** How many rows an auto-sized audit page will ask for at most. */
export const EVENT_MAX_PAGE_SIZE = 200;

/**
 * How many rows fit in `available` pixels, clamped to the page-size range.
 *
 * Pure, and therefore testable without a browser: the measurement is the
 * caller's job, the arithmetic is this one's.
 */
export function fitPageSize(
  available,
  rowHeight,
  min = EVENT_MIN_PAGE_SIZE,
  max = EVENT_MAX_PAGE_SIZE,
) {
  // A hidden or not-yet-laid-out page measures as nonsense; the floor is the
  // honest answer there, and the caller re-measures once it is on screen.
  if (!Number.isFinite(available) || !(rowHeight > 0)) return min;
  return Math.min(max, Math.max(min, Math.floor(available / rowHeight)));
}

/**
 * Merge two event lists — each newest-first — into one, deduped by id, newest
 * first, capped at `limit`. Used when a live event arrives over SSE and has to
 * land above the page the reader is looking at.
 */
export function mergeEvents(existing, incoming, limit = Infinity) {
  const byId = new Map();
  for (const event of [...existing, ...incoming]) {
    if (event && typeof event.id === "number" && !byId.has(event.id)) {
      byId.set(event.id, event);
    }
  }
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, limit);
}

/**
 * Whether an event matches the audit page's free-text filter. It looks at the
 * actor, source, action, the project, and the card it touched (id and title),
 * because a reader auditing "what happened to #38" types the id, not the event
 * type — and one auditing a project types its slug.
 */
export function matchesEvent(event, query, byId) {
  if (!query) return true;
  const card = byId?.get?.(event.cardId);
  return [
    event.type,
    event.actor?.type,
    event.actor?.name,
    event.source,
    describeEvent(event),
    `#${event.cardId}`,
    String(event.cardId),
    card?.title ?? "",
    // The column shows the server's attribution when it has one; the card is
    // the fallback for a row that arrived live.
    typeof event.project === "string" ? event.project : (card?.project ?? ""),
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}
