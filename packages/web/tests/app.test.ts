import { describe, expect, it } from "vitest";
import {
  COLUMNS,
  DOCS,
  DOCS_SECTIONS,
  DONE_PREVIEW,
  EVENT_MAX_PAGE_SIZE,
  EVENT_MIN_PAGE_SIZE,
  I18N,
  LANGUAGES,
  actionForColumn,
  actorOptions,
  blockedCardIds,
  describeEvent,
  docKindOf,
  escapeHtml,
  filterCards,
  fitPageSize,
  formatRelativeTime,
  markdownToHtml,
  matchesEvent,
  mergeEvents,
  normaliseDocPath,
  parseActor,
  previewCards,
  resolveDocRef,
  rewriteDocRefs,
  sortCards,
} from "../src/app.js";

const card = (overrides = {}) => ({
  id: 1,
  title: "card",
  body: null,
  state: "todo",
  assignee: null,
  reviewer: null,
  blockedBy: [],
  blocks: [],
  notes: [],
  createdBy: "jyxc",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  revision: 1,
  ...overrides,
});

describe("drag and drop maps to intent verbs", () => {
  it("resolves each column to its semantic action", () => {
    expect(actionForColumn("todo")).toBe("reopen");
    expect(actionForColumn("doing")).toBe("claim");
    expect(actionForColumn("review")).toBe("review");
    expect(actionForColumn("done")).toBe("done");
    // The shelf has no intent verb, so it is a move with an explicit target.
    expect(actionForColumn("someday")).toBe("move");
  });

  it("rejects unknown columns", () => {
    expect(() => actionForColumn("backlog")).toThrowError(/unknown column/);
  });

  it("covers every board column", () => {
    for (const column of COLUMNS) {
      expect(() => actionForColumn(column.id)).not.toThrow();
    }
  });
});

describe("filterCards", () => {
  it("matches note text and note links too", () => {
    const withNote = card({
      id: 2,
      notes: [{ id: 9, text: "design doc", url: "docs/design.md" }],
    });
    expect(filterCards([withNote], { q: "design" })).toHaveLength(1);
    expect(filterCards([withNote], { q: "docs/design.md" })).toHaveLength(1);
    expect(filterCards([withNote], { q: "nothing" })).toHaveLength(0);
  });

  const cards = [
    card({
      id: 1,
      title: "Fix login",
      body: "auth flow",
      assignee: "codex",
      reviewer: "jyxc",
    }),
    card({
      id: 2,
      title: "Write docs",
      assignee: "claude-code",
      state: "doing",
    }),
  ];

  it("matches on title and body, case-insensitively", () => {
    expect(filterCards(cards, { q: "LOGIN" }).map((c) => c.id)).toEqual([1]);
    expect(filterCards(cards, { q: "auth flow" }).map((c) => c.id)).toEqual([
      1,
    ]);
    expect(filterCards(cards, { q: "nothing" })).toHaveLength(0);
  });

  it("filters by assignee and reviewer", () => {
    expect(filterCards(cards, { assignee: "codex" }).map((c) => c.id)).toEqual([
      1,
    ]);
    expect(filterCards(cards, { reviewer: "jyxc" }).map((c) => c.id)).toEqual([
      1,
    ]);
  });

  it("treats empty filters as no-ops", () => {
    expect(filterCards(cards, {})).toHaveLength(2);
    expect(filterCards(cards, { q: "   " })).toHaveLength(2);
  });
});

describe("sortCards", () => {
  it("puts the most recently updated first", () => {
    const cards = [
      card({ id: 1, updatedAt: "2026-01-01T00:00:00.000Z" }),
      card({ id: 2, updatedAt: "2026-01-02T00:00:00.000Z" }),
      card({ id: 3, updatedAt: "2026-01-03T00:00:00.000Z" }),
    ];
    expect(sortCards(cards).map((c) => c.id)).toEqual([3, 2, 1]);
  });

  it("breaks ties by descending id", () => {
    const cards = [card({ id: 1 }), card({ id: 2 })];
    expect(sortCards(cards).map((c) => c.id)).toEqual([2, 1]);
  });

  it("does not mutate the input", () => {
    const cards = [card({ id: 1 }), card({ id: 2 })];
    sortCards(cards);
    expect(cards.map((c) => c.id)).toEqual([1, 2]);
  });

  it("orders by priority before recency", () => {
    // The regression: recency alone put a minor card above live work just
    // because someone touched it last week.
    const cards = [
      card({ id: 1, updatedAt: "2026-01-01T00:00:00.000Z", priority: "high" }),
      card({ id: 2, updatedAt: "2026-01-09T00:00:00.000Z" }),
      card({ id: 3, updatedAt: "2026-01-08T00:00:00.000Z", priority: "low" }),
      card({ id: 4, updatedAt: "2026-01-07T00:00:00.000Z", priority: "low" }),
    ];
    expect(sortCards(cards).map((c) => c.id)).toEqual([1, 2, 3, 4]);
  });

  it("keeps recency as the tiebreak inside one priority band", () => {
    const cards = [
      card({ id: 1, updatedAt: "2026-01-01T00:00:00.000Z", priority: "low" }),
      card({ id: 2, updatedAt: "2026-01-05T00:00:00.000Z", priority: "low" }),
    ];
    expect(sortCards(cards).map((c) => c.id)).toEqual([2, 1]);
  });

  it("treats a card with no priority as normal", () => {
    const cards = [
      card({ id: 1, priority: "low" }),
      { ...card({ id: 2 }), priority: undefined },
    ];
    expect(sortCards(cards).map((c) => c.id)).toEqual([2, 1]);
  });
});

describe("blockedCardIds", () => {
  it("flags cards whose blockers are not done", () => {
    const cards = [
      card({ id: 1, state: "doing" }),
      card({ id: 2, blockedBy: [1] }),
      card({ id: 3, blockedBy: [1] }),
    ];
    expect([...blockedCardIds(cards)]).toEqual([2, 3]);
  });

  it("clears the flag once the blocker is done", () => {
    const cards = [
      card({ id: 1, state: "done" }),
      card({ id: 2, blockedBy: [1] }),
    ];
    expect([...blockedCardIds(cards)]).toEqual([]);
  });

  it("treats a missing blocker as blocking (defensive)", () => {
    const cards = [card({ id: 2, blockedBy: [99] })];
    expect([...blockedCardIds(cards)]).toEqual([2]);
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-01-01T12:00:00.000Z").getTime();

  it("renders coarse buckets", () => {
    expect(formatRelativeTime("2026-01-01T11:59:50.000Z", now)).toBe(
      "just now",
    );
    expect(formatRelativeTime("2026-01-01T11:55:00.000Z", now)).toBe("5m ago");
    expect(formatRelativeTime("2026-01-01T09:00:00.000Z", now)).toBe("3h ago");
    expect(formatRelativeTime("2025-12-30T12:00:00.000Z", now)).toBe("2d ago");
  });

  it("never renders negative time for clock skew", () => {
    expect(formatRelativeTime("2026-01-01T12:05:00.000Z", now)).toBe(
      "just now",
    );
  });

  it("returns empty for garbage input", () => {
    expect(formatRelativeTime("not-a-date", now)).toBe("");
  });
});

describe("escapeHtml", () => {
  it("neutralises markup in user content", () => {
    expect(escapeHtml("<img src=x onerror=alert(1)>")).toBe(
      "&lt;img src=x onerror=alert(1)&gt;",
    );
    expect(escapeHtml("\"quoted\" & 'single'")).toBe(
      "&quot;quoted&quot; &amp; &#39;single&#39;",
    );
  });

  it("passes through plain text and nullish values", () => {
    expect(escapeHtml("plain")).toBe("plain");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("parseActor", () => {
  const fallback = { name: "me", type: "human" };

  it("accepts a valid stored identity", () => {
    expect(
      parseActor('{"name":"claude-code","type":"agent"}', fallback),
    ).toEqual({
      name: "claude-code",
      type: "agent",
    });
  });

  it("falls back on invalid or missing data", () => {
    expect(parseActor("not json", fallback)).toEqual(fallback);
    expect(parseActor('{"name":"","type":"human"}', fallback)).toEqual(
      fallback,
    );
    expect(parseActor('{"name":"x","type":"robot"}', fallback)).toEqual(
      fallback,
    );
    expect(parseActor(null, fallback)).toEqual(fallback);
  });

  it("trims the name", () => {
    expect(parseActor('{"name":"  jyxc  ","type":"human"}', fallback)).toEqual({
      name: "jyxc",
      type: "human",
    });
  });
});

describe("actorOptions", () => {
  it("lists distinct, sorted names for a role", () => {
    const cards = [
      card({ id: 1, assignee: "codex", reviewer: "jyxc" }),
      card({ id: 2, assignee: "claude-code", reviewer: "jyxc" }),
      card({ id: 3, assignee: "codex", reviewer: null }),
    ];
    expect(actorOptions(cards, "assignee")).toEqual(["claude-code", "codex"]);
    expect(actorOptions(cards, "reviewer")).toEqual(["jyxc"]);
  });
});

describe("document links", () => {
  it("tells a hosted link from a local document", () => {
    expect(docKindOf("https://example.com/design.md")).toBe("link");
    expect(docKindOf("docs/design.md")).toBe("markdown");
    expect(docKindOf("docs/design.markdown")).toBe("markdown");
    expect(docKindOf("~/notes/page.html")).toBe("html");
    expect(docKindOf("file:///tmp/page.htm")).toBe("html");
    expect(docKindOf("notes.txt")).toBe("text");
    expect(docKindOf("")).toBeNull();
    expect(docKindOf(null)).toBeNull();
  });

  it("resolves a relative reference against the document's directory", () => {
    expect(resolveDocRef("./diagram.png", "/repo/docs/design.md")).toBe(
      "/api/doc?raw=1&path=%2Frepo%2Fdocs%2Fdiagram.png",
    );
    expect(resolveDocRef("../other/page.md", "/repo/docs/design.md")).toBe(
      "/api/doc?raw=1&path=%2Frepo%2Fother%2Fpage.md",
    );
  });

  it("leaves absolute and remote references alone", () => {
    expect(resolveDocRef("https://example.com/x", "/repo/docs/design.md")).toBe(
      "https://example.com/x",
    );
    expect(resolveDocRef("#section", "/repo/docs/design.md")).toBe("#section");
    expect(resolveDocRef("mailto:a@b.c", "/repo/docs/design.md")).toBe(
      "mailto:a@b.c",
    );
    expect(resolveDocRef("/abs/page.md", "/repo/docs/design.md")).toBe(
      "/api/doc?raw=1&path=%2Fabs%2Fpage.md",
    );
  });

  it("collapses . and .. without touching the filesystem", () => {
    expect(normaliseDocPath("/a/b/../c/./d.md")).toBe("/a/c/d.md");
    expect(normaliseDocPath("a/b")).toBe("/a/b");
  });

  it("rewrites relative refs in an HTML document", () => {
    const html =
      '<img src="./a.png"><a href="/abs/page.html">x</a><a href="https://e.com">y</a>';
    expect(rewriteDocRefs(html, "/repo/docs/page.html")).toBe(
      '<img src="/api/doc?raw=1&path=%2Frepo%2Fdocs%2Fa.png">' +
        '<a href="/api/doc?raw=1&path=%2Fabs%2Fpage.html">x</a>' +
        '<a href="https://e.com">y</a>',
    );
  });
});

describe("markdownToHtml", () => {
  const options = {
    resolveHref: (href) => resolveDocRef(href, "/repo/docs/design.md"),
    resolveSrc: (src) => resolveDocRef(src, "/repo/docs/design.md"),
  };

  it("renders the blocks a design doc uses", () => {
    const html = markdownToHtml(
      [
        "# Title",
        "",
        "A paragraph with **bold**, *italic* and `code`.",
        "",
        "- one",
        "- two",
        "",
        "> quoted",
        "",
        "```js",
        'const x = "<b>";',
        "```",
        "",
        "| A | B |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "---",
      ].join("\n"),
      options,
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<pre><code>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td>2</td>");
    expect(html).toContain("<hr />");
  });

  it("nests a list inside its parent item", () => {
    const html = markdownToHtml("- one\n  - nested\n- two", options);
    expect(html).toBe(
      "<ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul>",
    );
  });

  it("escapes markup instead of trusting it", () => {
    const html = markdownToHtml(
      '<script>alert(1)</script> and <img src=x onerror="alert(1)">',
      options,
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    // escaped, so it is text in the document rather than markup in the page
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("onerror=&quot;");
  });

  it("drops a dangerous link scheme and keeps the label", () => {
    const html = markdownToHtml("[click](javascript:alert(1))", options);
    expect(html).not.toContain("javascript:");
    expect(html).toContain(">click</a>");
  });

  it("resolves links and images through the doc endpoint", () => {
    const html = markdownToHtml(
      "[page](./page.md) ![diagram](./diagram.png)",
      options,
    );
    expect(html).toContain(
      'href="/api/doc?raw=1&path=%2Frepo%2Fdocs%2Fpage.md"',
    );
    expect(html).toContain(
      'src="/api/doc?raw=1&path=%2Frepo%2Fdocs%2Fdiagram.png"',
    );
  });

  it("linkifies a bare url and leaves code spans alone", () => {
    const html = markdownToHtml(
      "see https://example.com/x and `a_b_c`",
      options,
    );
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain("<code>a_b_c</code>");
  });
});
describe("documentation content", () => {
  it("has unique section ids and non-empty content", () => {
    const ids = DOCS_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const section of DOCS_SECTIONS) {
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.lead.length).toBeGreaterThan(0);
      expect(section.blocks.length).toBeGreaterThan(0);
    }
  });

  it("covers the whole product", () => {
    const titles = DOCS_SECTIONS.map((section) => section.title);
    for (const expected of [
      "What is using-kanban?",
      "The workflow",
      "Using this UI",
      "The ukb CLI",
      "Connecting an agent",
      "Build your own UI",
      "Concepts",
      "Troubleshooting",
    ]) {
      expect(titles).toContain(expected);
    }
  });

  it("teaches the one rule — claim before working", () => {
    const workflow = DOCS_SECTIONS.find((section) => section.id === "workflow");
    const text = JSON.stringify(workflow);
    expect(text).toContain("claim");
    expect(text.toLowerCase()).toContain("before starting work");
  });

  it("documents every transition verb and the drag semantics", () => {
    const ui = JSON.stringify(
      DOCS_SECTIONS.find((section) => section.id === "web-ui"),
    );
    for (const verb of ["claim", "review", "done", "reopen"]) {
      expect(ui).toContain(verb);
    }
    // and the workflow states must match the board's columns
    const workflow = JSON.stringify(
      DOCS_SECTIONS.find((section) => section.id === "workflow"),
    );
    for (const column of COLUMNS) {
      expect(workflow).toContain(column.id);
    }
  });

  it("uses only block types the renderer understands", () => {
    const known = new Set(["p", "h", "code", "ul", "table"]);
    for (const section of DOCS_SECTIONS) {
      for (const block of section.blocks) {
        expect(known.has(block.t)).toBe(true);
        if (block.t === "table") {
          expect(block.head.length).toBeGreaterThan(0);
          for (const row of block.rows) {
            expect(row).toHaveLength(block.head.length);
          }
        }
        if (block.t === "ul") {
          for (const item of block.items) {
            expect(item).toHaveLength(2);
          }
        }
      }
    }
  });

  it("explains every error code the API can return", () => {
    const troubleshooting = JSON.stringify(
      DOCS_SECTIONS.find((section) => section.id === "troubleshooting"),
    );
    for (const code of [
      "claim_conflict",
      "forbidden",
      "card_not_found",
      "revision_conflict",
      "invalid_state",
      "unauthorized",
    ]) {
      expect(troubleshooting).toContain(code);
    }
  });
});

describe("internationalisation", () => {
  it("exposes the two supported languages", () => {
    expect(LANGUAGES.map((language) => language.code).sort()).toEqual([
      "en",
      "zh",
    ]);
  });

  it("has the same keys in both languages", () => {
    const en = Object.keys(I18N.en).sort();
    const zh = Object.keys(I18N.zh).sort();
    expect(zh).toEqual(en);
  });

  it("has no empty or untranslated strings", () => {
    for (const [code, table] of Object.entries(I18N)) {
      for (const [key, value] of Object.entries(table)) {
        expect(value.trim().length, `${code}.${key} is empty`).toBeGreaterThan(
          0,
        );
      }
    }
    // Chinese must actually be Chinese, not a copy of English — except for
    // values that are language-neutral symbols.
    const neutral = new Set(["drawer.none"]);
    const identical = Object.keys(I18N.en).filter(
      (key) => !neutral.has(key) && I18N.zh[key] === I18N.en[key],
    );
    expect(identical).toEqual([]);
  });

  it("keeps interpolation placeholders in both languages", () => {
    for (const key of Object.keys(I18N.en)) {
      const en = (I18N.en[key].match(/\{(\w+)\}/g) ?? []).sort();
      const zh = (I18N.zh[key].match(/\{(\w+)\}/g) ?? []).sort();
      expect(zh, `placeholders differ for ${key}`).toEqual(en);
    }
  });

  it("has every board state and error code translated", () => {
    for (const column of COLUMNS) {
      expect(I18N.en[`column.${column.id}`]).toBeTruthy();
      expect(I18N.zh[`column.${column.id}`]).toBeTruthy();
    }
    for (const code of [
      "claim_conflict",
      "forbidden",
      "card_not_found",
      "revision_conflict",
      "invalid_state",
      "unauthorized",
      "invalid_input",
      "internal_error",
    ]) {
      expect(I18N.en[`error.${code}`], `en error.${code}`).toBeTruthy();
      expect(I18N.zh[`error.${code}`], `zh error.${code}`).toBeTruthy();
    }
  });

  it("translates every relative-time bucket", () => {
    for (const bucket of [
      "justNow",
      "minutes",
      "hours",
      "days",
      "months",
      "years",
    ]) {
      expect(I18N.en[`time.${bucket}`]).toBeTruthy();
      expect(I18N.zh[`time.${bucket}`]).toBeTruthy();
    }
  });
});

describe("documentation in both languages", () => {
  const sectionIds = (sections) => sections.map((section) => section.id);

  it("has the same sections in both languages", () => {
    const en = sectionIds(DOCS_SECTIONS);
    const zh = sectionIds(DOCS.zh);
    expect(zh).toEqual(en);
    expect(en.length).toBeGreaterThanOrEqual(8);
  });

  it("translates titles and leads", () => {
    for (const section of DOCS_SECTIONS) {
      const zh = DOCS.zh.find((entry) => entry.id === section.id);
      expect(zh, `missing zh section ${section.id}`).toBeDefined();
      expect(zh?.title).not.toBe(section.title);
      expect(zh?.lead).not.toBe(section.lead);
      expect(zh?.blocks.length).toBe(section.blocks.length);
    }
  });

  it("keeps table shapes identical across languages", () => {
    for (const section of DOCS_SECTIONS) {
      const zh = DOCS.zh.find((entry) => entry.id === section.id);
      if (!zh) continue;
      section.blocks.forEach((block, index) => {
        const zhBlock = zh.blocks[index];
        expect(zhBlock?.t).toBe(block.t);
        if (block.t === "table") {
          // headers are translated, but the shape must match exactly
          expect(zhBlock.head.length).toBe(block.head.length);
          expect(zhBlock.rows.length).toBe(block.rows.length);
          for (const [rowIndex, row] of block.rows.entries()) {
            expect(
              zhBlock.rows[rowIndex]?.length,
              `row ${rowIndex} width`,
            ).toBe(row.length);
          }
        }
      });
    }
  });
});

describe("project filtering", () => {
  const cards = [
    {
      id: 1,
      title: "web one",
      project: "web",
      state: "todo",
      assignee: "jyxc",
    },
    {
      id: 2,
      title: "api one",
      project: "api",
      state: "todo",
      assignee: "jyxc",
    },
    { id: 3, title: "untagged", project: null, state: "todo", assignee: null },
  ].map((card) => ({
    ...card,
    body: null,
    reviewer: null,
    blockedBy: [],
    createdBy: "jyxc",
    createdAt: "",
    updatedAt: "",
    revision: 1,
  }));

  it("passes only the selected project's cards", () => {
    const web = filterCards(cards, { project: "web" });
    expect(web.map((card) => card.title)).toEqual(["web one"]);
  });

  it("shows every project when the filter is empty", () => {
    expect(filterCards(cards, { project: "" })).toHaveLength(3);
    expect(filterCards(cards, {})).toHaveLength(3);
  });

  it("is a partition: untagged cards are not in any project", () => {
    for (const project of ["web", "api"]) {
      const titles = filterCards(cards, { project }).map((c) => c.title);
      expect(titles).not.toContain("untagged");
    }
  });

  it("composes with the other filters", () => {
    expect(
      filterCards(cards, { project: "web", assignee: "jyxc" }),
    ).toHaveLength(1);
    expect(
      filterCards(cards, { project: "web", assignee: "codex" }),
    ).toHaveLength(0);
  });
});

describe("column preview and expansion", () => {
  const doneCards = (count) =>
    Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      title: `finished ${index + 1}`,
      state: "done",
    }));

  it("previews the done column instead of rendering all of it", () => {
    // The constant is exported so the UI and the test agree on the preview size.
    // previewCards takes the column's own cards — renderBoard filters by state
    // first — so only done cards are passed here.
    const cards = doneCards(DONE_PREVIEW + 20).map((card) => ({
      ...card,
      project: null,
      body: null,
      assignee: null,
      reviewer: null,
      blockedBy: [],
      createdBy: "jyxc",
      createdAt: "",
      updatedAt: "",
      revision: 1,
    }));

    const preview = previewCards(cards, "done", false);
    expect(preview.shown).toBe(DONE_PREVIEW);
    expect(preview.hidden).toBe(20);
    expect(preview.collapsed).toBe(true);
  });

  it("shows everything once the column is expanded", () => {
    const cards = doneCards(DONE_PREVIEW + 5).map((card) => ({
      ...card,
      project: null,
      body: null,
      assignee: null,
      reviewer: null,
      blockedBy: [],
      createdBy: "jyxc",
      createdAt: "",
      updatedAt: "",
      revision: 1,
    }));

    const all = previewCards(cards, "done", true);
    expect(all.shown).toBe(DONE_PREVIEW + 5);
    expect(all.hidden).toBe(0);
    expect(all.collapsed).toBe(false);
  });

  it("never collapses a column that fits in the preview", () => {
    const cards = doneCards(3).map((card) => ({
      ...card,
      project: null,
      body: null,
      assignee: null,
      reviewer: null,
      blockedBy: [],
      createdBy: "jyxc",
      createdAt: "",
      updatedAt: "",
      revision: 1,
    }));

    const result = previewCards(cards, "done", false);
    expect(result.shown).toBe(3);
    expect(result.collapsed).toBe(false);
  });

  it("leaves the live columns alone", () => {
    const cards = Array.from({ length: 40 }, (_, index) => ({
      id: index + 1,
      title: `card ${index}`,
      state: "review",
      project: null,
      body: null,
      assignee: null,
      reviewer: null,
      blockedBy: [],
      createdBy: "jyxc",
      createdAt: "",
      updatedAt: "",
      revision: 1,
    }));

    // review is a live column: 40 cards must all render, preview or not
    expect(previewCards(cards, "review", false).shown).toBe(40);
    expect(previewCards(cards, "review", false).collapsed).toBe(false);
  });

  it("previews the someday shelf, like done", () => {
    const cards = Array.from({ length: DONE_PREVIEW + 3 }, (_, index) => ({
      id: index + 1,
      title: `parked ${index}`,
      state: "someday",
      project: null,
      body: null,
      assignee: null,
      reviewer: null,
      blockedBy: [],
      createdBy: "jyxc",
      createdAt: "",
      updatedAt: "",
      revision: 1,
    }));

    const preview = previewCards(cards, "someday", false);
    expect(preview.collapsed).toBe(true);
    expect(preview.hidden).toBe(3);
  });
});

const event = (type, payload = {}, over = {}) => ({
  id: 1,
  ts: "2026-01-01T00:00:00.000Z",
  actor: { type: "agent", name: "pi" },
  source: "cli",
  type,
  cardId: 3,
  payload,
  ...over,
});

describe("describeEvent", () => {
  it("names every event type the log can hold", () => {
    expect(describeEvent(event("card.created"))).toBe("created");
    expect(describeEvent(event("card.updated"))).toBe("edited");
    expect(
      describeEvent(
        event("card.moved", { action: "claim", from: "todo", to: "doing" }),
      ),
    ).toBe("claim todo→doing");
    expect(describeEvent(event("card.deleted"))).toBe("deleted");
    expect(
      describeEvent(event("card.dependency_added", { blockedBy: 7 })),
    ).toBe("blocked on #7");
    expect(
      describeEvent(event("card.dependency_removed", { blockedBy: 7 })),
    ).toBe("unblocked from #7");
    expect(describeEvent(event("card.parent_set", { parent: 38 }))).toBe(
      "child of #38",
    );
    expect(describeEvent(event("card.parent_cleared"))).toBe(
      "detached from its parent",
    );
    expect(describeEvent(event("card.note_added"))).toBe("added a note");
    expect(describeEvent(event("card.note_updated", { note: 9 }))).toBe(
      "edited note #9",
    );
    expect(describeEvent(event("card.note_removed", { note: 9 }))).toBe(
      "removed note #9",
    );
  });

  it("falls back to the raw type for something it does not know", () => {
    expect(describeEvent(event("card.teleported"))).toBe("card.teleported");
  });
});

describe("mergeEvents", () => {
  const at = (id) => ({ id });

  it("dedupes by id, newest first, capped at the limit", () => {
    expect(
      mergeEvents([at(3), at(1)], [at(2), at(1)], 2).map((e) => e.id),
    ).toEqual([3, 2]);
  });

  it("ignores anything without an id", () => {
    expect(
      mergeEvents([at(1)], [{ nope: true }, null]).map((e) => e.id),
    ).toEqual([1]);
  });
});

describe("matchesEvent", () => {
  const moved = event("card.moved", {
    action: "claim",
    from: "todo",
    to: "doing",
  });
  const byId = new Map([[3, { id: 3, title: "Ship v2", project: "gala" }]]);

  it("matches everything when the query is empty", () => {
    expect(matchesEvent(moved, "", byId)).toBe(true);
  });

  it("matches the actor, the action, the id, the project and the card title", () => {
    expect(matchesEvent(moved, "pi", byId)).toBe(true);
    expect(matchesEvent(moved, "claim", byId)).toBe(true);
    expect(matchesEvent(moved, "#3", byId)).toBe(true);
    expect(matchesEvent(moved, "ship v2", byId)).toBe(true);
    // The project column is part of the page, so it is part of the search.
    expect(matchesEvent(moved, "gala", byId)).toBe(true);
    expect(matchesEvent(moved, "nothing", byId)).toBe(false);
  });

  it("finds the project of a row whose card is gone", () => {
    // The server attributes the project to every event it returns, so a
    // deleted card's rows still answer to its slug — and no board lookup can
    // answer that one.
    const orphaned = event("card.deleted", {}, { project: "gala" });
    expect(matchesEvent(orphaned, "gala", new Map())).toBe(true);
  });
});

describe("fitPageSize", () => {
  it("asks for the rows that fit, not a round number", () => {
    expect(fitPageSize(700, 42)).toBe(16);
    expect(fitPageSize(420, 42)).toBe(10);
  });

  it("never goes below the floor, however short the window", () => {
    expect(fitPageSize(0, 42)).toBe(EVENT_MIN_PAGE_SIZE);
    expect(fitPageSize(-200, 42)).toBe(EVENT_MIN_PAGE_SIZE);
    expect(fitPageSize(10, 42)).toBe(EVENT_MIN_PAGE_SIZE);
  });

  it("never goes above the ceiling, however tall the window", () => {
    expect(fitPageSize(100_000, 42)).toBe(EVENT_MAX_PAGE_SIZE);
  });

  it("falls back to the floor when the layout cannot be measured", () => {
    // A hidden page measures as NaN or zero; the caller re-measures once the
    // page is on screen, so the floor is the safe answer meanwhile.
    expect(fitPageSize(Number.NaN, 42)).toBe(EVENT_MIN_PAGE_SIZE);
    expect(fitPageSize(600, 0)).toBe(EVENT_MIN_PAGE_SIZE);
  });
});
