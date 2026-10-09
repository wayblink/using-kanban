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
  const project = String(filter.project ?? "").trim();

  return cards.filter((card) => {
    if (assignee && card.assignee !== assignee) return false;
    if (reviewer && card.reviewer !== reviewer) return false;
    if (project && card.project !== project) return false;
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
    "column.todo": "Todo",
    "column.doing": "Doing",
    "column.review": "Review",
    "column.done": "Done",
    "column.empty": "nothing here",
    "card.project": "project:",
    "filter.anyProject": "any project",
    "filter.anyAssignee": "any assignee",
    "filter.anyReviewer": "any reviewer",
    "card.reviewer": "reviewer:",
    "card.blockedBy": "blocked-by:",
    "time.justNow": "just now",
    "time.minutes": "{n}m ago",
    "time.hours": "{n}h ago",
    "time.days": "{n}d ago",
    "time.months": "{n}mo ago",
    "time.years": "{n}y ago",
    "drawer.assignee": "Assignee",
    "drawer.reviewer": "Reviewer",
    "drawer.project": "Project",
    "drawer.blockedBy": "Blocked by",
    "drawer.body": "Body",
    "drawer.history": "History",
    "drawer.title": "Title",
    "drawer.claim": "Claim",
    "drawer.requestReview": "Request review",
    "drawer.done": "Done",
    "drawer.reopen": "Reopen",
    "drawer.delete": "Delete card",
    "drawer.blockOn": "block on card #",
    "drawer.block": "Block",
    "drawer.createdBy": "created by",
    "drawer.revision": "revision",
    "drawer.updated": "updated",
    "drawer.none": "—",
    "drawer.close": "close",
    "drawer.unblock": "unblock {id}",
    "drawer.confirmDelete": "Delete card #{id}? This cannot be undone.",
    "modal.newCard": "New card",
    "modal.body": "Body — target files, acceptance criteria",
    "modal.cancel": "Cancel",
    "modal.create": "Create card",
    "modal.needsTitle": "a card needs a title",
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
    "column.todo": "待办",
    "column.doing": "进行中",
    "column.review": "审查中",
    "column.done": "已完成",
    "column.empty": "暂无卡片",
    "card.project": "项目：",
    "filter.anyProject": "全部项目",
    "filter.anyAssignee": "全部负责人",
    "filter.anyReviewer": "全部审查者",
    "card.reviewer": "审查：",
    "card.blockedBy": "阻塞：",
    "time.justNow": "刚刚",
    "time.minutes": "{n} 分钟前",
    "time.hours": "{n} 小时前",
    "time.days": "{n} 天前",
    "time.months": "{n} 个月前",
    "time.years": "{n} 年前",
    "drawer.assignee": "负责人",
    "drawer.reviewer": "审查者",
    "drawer.project": "项目",
    "drawer.blockedBy": "阻塞于",
    "drawer.body": "描述",
    "drawer.history": "历史记录",
    "drawer.title": "标题",
    "drawer.claim": "认领",
    "drawer.requestReview": "提交审查",
    "drawer.done": "完成",
    "drawer.reopen": "重新打开",
    "drawer.delete": "删除卡片",
    "drawer.blockOn": "阻塞于卡片 #",
    "drawer.block": "阻塞",
    "drawer.createdBy": "创建者",
    "drawer.revision": "版本",
    "drawer.updated": "更新于",
    "drawer.none": "—",
    "drawer.close": "关闭",
    "drawer.unblock": "解除阻塞 {id}",
    "drawer.confirmDelete": "删除卡片 #{id}？此操作无法撤销。",
    "modal.newCard": "新建卡片",
    "modal.body": "描述 — 目标文件、验收标准",
    "modal.cancel": "取消",
    "modal.create": "创建卡片",
    "modal.needsTitle": "卡片需要标题",
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

const DOCS_ZH = [
  {
    id: "overview",
    title: "什么是 using-kanban？",
    lead: "一个面向 AI 智能体与人类的无头看板。",
    blocks: [
      {
        t: "p",
        text: "每个项目一块看板，存放在代码旁的 `.ukb/` 目录中。智能体与人类共用它：智能体通过 MCP 工具或命令行认领工作，人类通过这个界面观察与调度。",
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
    lead: "四列看板，一条规则：先认领，再动手。",
    blocks: [
      {
        t: "table",
        head: ["状态", "含义", "如何进入"],
        rows: [
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
        ],
      },
      {
        t: "p",
        text: "如果认领失败——已经有别人在处理这张卡片——你会看到服务端返回的原因提示，看板也会回退到服务端状态。任何操作都不会被悄悄覆盖。",
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
            "卡片抽屉",
            "点击任意卡片可编辑标题/描述/负责人/审查者、执行状态流转、管理阻塞关系、查看事件历史，或删除卡片（仅创建者）。",
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
          ["DELETE", "/api/cards/:id", "删除（仅创建者）"],
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
            "依赖",
            "一张卡片可以等待其他卡片（block 4 --by 3）。环路与自阻塞会被拒绝。存在未完成阻塞项的卡片会被标记，而不是隐藏。",
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
        text: "智能体：请在要操作看板的项目目录下运行 ukb（或 kanban_my_cards）——存储位于当前目录的 .ukb/。如果无法解析身份，请传入 --agent <名称>。",
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

  const els = {
    board: document.getElementById("board"),
    docs: document.getElementById("docs"),
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
    drawerBackdrop: document.getElementById("drawer-backdrop"),
    drawer: document.getElementById("drawer"),
    modalBackdrop: document.getElementById("modal-backdrop"),
    modal: document.getElementById("modal"),
    toasts: document.getElementById("toasts"),
  };

  const state = {
    cards: [],
    actor: { name: "me", type: "human" },
    filter: { q: "", project: "", assignee: "", reviewer: "" },
    openCardId: null,
    dragCardId: null,
    route: currentRoute(),
    lang: loadLanguage(),
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
    // the drawer is built from translated labels, so rebuild it if it is open
    const openCardId = state.openCardId;
    if (openCardId !== null) {
      state.openCardId = null;
      void openDrawer(openCardId);
    }
    render();
    if (state.route === "docs") void renderDocs();
  }

  /** `#/board` or `#/docs` — the docs page is the home page. */
  function currentRoute() {
    const hash = window.location.hash.replace(/^#\/?/, "");
    return hash.startsWith("board") ? "board" : "docs";
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

    els.board.hidden = onDocs;
    els.docs.hidden = !onDocs;
    els.boardControls.hidden = onDocs;

    for (const link of document.querySelectorAll(".nav-link")) {
      const active = link.dataset.route === state.route;
      link.classList.toggle("active", active);
      link.setAttribute("aria-current", active ? "page" : "false");
    }

    if (!onDocs) {
      void refresh();
      return;
    }

    // Only build the docs once. A section link must scroll, not re-render —
    // re-rendering would reset the scroll position.
    if (!docsRendered) {
      docsRendered = true;
      closeDrawer();
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
      label.textContent = t(`column.${column.id}`);
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
        empty.textContent = t("column.empty");
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
    if (card.project)
      meta.append(badge(`${t("card.project")}${card.project}`, "project"));
    if (card.reviewer)
      meta.append(badge(`${t("card.reviewer")}${card.reviewer}`, "reviewer"));
    if (blocked) {
      meta.append(
        badge(`${t("card.blockedBy")}${card.blockedBy.join(",")}`, "blocked"),
      );
    }
    meta.append(badge(formatRelativeTime(card.updatedAt, Date.now(), t), ""));

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
    pill.textContent = t(`column.${card.state}`);
    const close = document.createElement("button");
    close.className = "icon-button";
    close.type = "button";
    close.textContent = "✕";
    close.setAttribute("aria-label", t("drawer.close"));
    close.addEventListener("click", closeDrawer);
    header.append(heading, pill, close);

    const body = document.createElement("div");
    body.className = "drawer-body";

    // editable fields
    body.append(
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

    const assignee = document.createElement("div");
    assignee.className = "row";
    assignee.append(
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
        textInput(card.project ?? "", async (value) => {
          await saveCard(id, { project: value });
        }),
      ),
    );
    body.append(assignee);

    // actions
    const actions = document.createElement("div");
    actions.className = "actions";
    for (const [labelKey, action, enabled] of [
      ["drawer.claim", "claim", card.state === "todo"],
      [
        "drawer.requestReview",
        "review",
        card.state !== "done" && card.state !== "review",
      ],
      ["drawer.done", "done", card.state !== "done"],
      ["drawer.reopen", "reopen", card.state !== "todo"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = t(labelKey);
      button.disabled = !enabled;
      button.addEventListener("click", () => void transition(id, action));
      actions.append(button);
    }
    body.append(actions);

    // blockers
    const blockersField = field(t("drawer.blockedBy"));
    const blockers = document.createElement("div");
    blockers.className = "blockers";
    const blockersOf = (candidate) => candidate.blockedBy ?? [];
    if (blockersOf(card).length === 0) {
      const none = document.createElement("span");
      none.className = "badge";
      none.textContent = t("drawer.none");
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
      remove.setAttribute("aria-label", t("drawer.unblock", { id: blockerId }));
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
    blockInput.placeholder = t("drawer.blockOn");
    blockInput.min = "1";
    const blockButton = document.createElement("button");
    blockButton.type = "button";
    blockButton.textContent = t("drawer.block");
    blockButton.addEventListener("click", async () => {
      const blockedBy = Number(blockInput.value);
      if (!Number.isInteger(blockedBy) || blockedBy <= 0) {
        toast(t("modal.enterId"), "error");
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
    const historyField = field(t("drawer.history"));
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
        what.textContent = `${describeEvent(event)} · ${formatRelativeTime(event.ts, Date.now(), t)}`;
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
    del.textContent = t("drawer.delete");
    del.addEventListener("click", async () => {
      if (!window.confirm(t("drawer.confirmDelete", { id }))) return;
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
    heading.textContent = t("modal.newCard");

    const title = textInput("", () => {});
    const bodyInput = textArea("", () => {});
    const assignee = textInput(state.actor.name, () => {});
    const reviewer = textInput("", () => {});
    const project = textInput("", () => {});

    const row = document.createElement("div");
    row.className = "row";
    row.append(
      field(t("drawer.assignee"), assignee),
      field(t("drawer.reviewer"), reviewer),
      field(t("drawer.project"), project),
    );

    const form = document.createElement("div");
    form.className = "drawer-body";
    form.append(
      field(t("drawer.title"), title),
      field(t("modal.body"), bodyInput),
      row,
    );

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = t("modal.cancel");
    cancel.addEventListener("click", closeModal);
    const create = document.createElement("button");
    create.type = "button";
    create.className = "primary";
    create.textContent = t("modal.create");
    create.addEventListener("click", async () => {
      if (!title.value.trim()) {
        toast(t("modal.needsTitle"), "error");
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
            project: project.value.trim() || undefined,
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

  /* ------------------------------- wiring ---------------------------- */

  els.newCard.addEventListener("click", openModal);
  for (const button of document.querySelectorAll(".lang-option")) {
    button.addEventListener("click", () => setLanguage(button.dataset.lang));
  }
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
  els.filterProject.addEventListener("change", () => {
    state.filter.project = els.filterProject.value;
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
