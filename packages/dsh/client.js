/**
 * Browser half of the using-kanban bundle.
 *
 *  - a right-Sidebar `Kanban` panel with filters (search, project, scope, density);
 *  - a composer chip with doing/todo/review counts that opens that panel;
 *  - a Tool view for `ukb` calls: board JSON becomes the same columns, other
 *    verbs a compact command card.
 *
 * Plain JS on purpose: the browser module table supplies React, so a DSH bundle
 * needs no build step to ship a client plugin.
 */
window.__ModuleLoader__.load({
  id: "@wayblink/using-kanban-dsh",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;
    /** Latest client context, for the chip's click handler. */
    const ctxRef = { current: null };

    /* --------------------------------- tokens -------------------------------- */

    /** Host theme tokens, each with a neutral fallback so a rename degrades. */
    const T = {
      text: "var(--dsw-alias-label-primary, currentColor)",
      text2:
        "var(--dsw-alias-label-secondary, color-mix(in srgb, currentColor 70%, transparent))",
      text3:
        "var(--dsw-alias-label-tertiary, color-mix(in srgb, currentColor 52%, transparent))",
      caption:
        "var(--dsw-alias-label-caption, color-mix(in srgb, currentColor 45%, transparent))",
      base: "var(--dsw-alias-bg-base, transparent)",
      layer1:
        "var(--dsw-alias-bg-layer-1, color-mix(in srgb, currentColor 4%, transparent))",
      layer2:
        "var(--dsw-alias-bg-layer-2, color-mix(in srgb, currentColor 7%, transparent))",
      card: "var(--dsw-alias-card-fill, color-mix(in srgb, currentColor 3%, transparent))",
      border1:
        "var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 10%, transparent))",
      border2:
        "var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))",
      border3:
        "var(--dsw-alias-border-l3, color-mix(in srgb, currentColor 26%, transparent))",
      hover:
        "var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 7%, transparent))",
      accent: "var(--dsw-alias-brand-primary, currentColor)",
      business:
        "var(--dsw-alias-state-business-primary, color-mix(in srgb, currentColor 72%, transparent))",
      success:
        "var(--dsw-alias-state-success-primary, color-mix(in srgb, currentColor 62%, transparent))",
      warn: "var(--dsw-alias-state-warn-primary, color-mix(in srgb, currentColor 55%, transparent))",
      danger:
        "var(--dsw-alias-state-error-primary, color-mix(in srgb, currentColor 80%, transparent))",
    };

    const TAB_KIND = "ukb-board";
    const TAB_ID = "@wayblink/using-kanban-dsh/board";
    const DENSITY_KEY = "ukb.panel.density";

    // Flow order: work first, history third-from-last, the shelf last — the same
    // order the `ukb web` board uses.
    const STATES = ["todo", "doing", "review", "done", "someday"];
    const STATE_LABEL = {
      someday: "Someday",
      todo: "Todo",
      doing: "Doing",
      review: "Review",
      done: "Done",
    };
    /** Rendered rows per column: `done` is history, the others are the work. */
    const STATE_LIMIT = {
      todo: 200,
      doing: 200,
      review: 200,
      done: 25,
      someday: 60,
    };
    // One hue per state, the same values the `ukb web` board uses (`--col-*`),
    // so a card area is recognizable before its label is read.
    const STATE_COLOR = {
      todo: "#64748b",
      doing: "#2563eb",
      review: "#d97706",
      done: "#16a34a",
      someday: "#8b8fa3",
    };

    /* -------------------------------- primitives ------------------------------ */

    function chip(text, options = {}) {
      const { strong = false, color = null, mono = false } = options;
      return h(
        "span",
        {
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "1px 7px",
            height: 18,
            borderRadius: 999,
            font: mono
              ? "500 10.5px/1 ui-monospace, SFMono-Regular, Menlo, monospace"
              : "500 11px/1 inherit",
            letterSpacing: "0.01em",
            color: color ?? (strong ? T.text : T.text2),
            background: T.layer1,
            border: `1px solid ${T.border1}`,
            whiteSpace: "nowrap",
            maxWidth: 180,
            overflow: "hidden",
            textOverflow: "ellipsis",
          },
          title: typeof text === "string" ? text : "",
        },
        text,
      );
    }

    function iconButton(label, onClick, active = false) {
      return h(
        "button",
        {
          type: "button",
          onClick,
          title: label,
          "aria-label": label,
          style: {
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            height: 28,
            minWidth: 28,
            padding: "0 8px",
            borderRadius: 8,
            border: `1px solid ${active ? T.border3 : T.border1}`,
            background: active ? T.layer2 : "transparent",
            color: active ? T.text : T.text2,
            font: "500 11px/1 inherit",
            cursor: "pointer",
            transition:
              "background 120ms ease, border-color 120ms ease, color 120ms ease",
          },
        },
        label,
      );
    }

    function segmented(options, value, onChange) {
      return h(
        "div",
        {
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 2,
            padding: 2,
            borderRadius: 9,
            background: T.layer1,
            border: `1px solid ${T.border1}`,
          },
        },
        ...options.map((option) =>
          h(
            "button",
            {
              key: option.value,
              type: "button",
              onClick: () => onChange(option.value),
              title: option.title ?? option.label,
              style: {
                height: 22,
                padding: "0 9px",
                borderRadius: 7,
                border: `1px solid ${value === option.value ? T.border2 : "transparent"}`,
                background: value === option.value ? T.card : "transparent",
                color: value === option.value ? T.text : T.text2,
                font: `${value === option.value ? 600 : 500} 11px/1 inherit`,
                cursor: "pointer",
                whiteSpace: "nowrap",
              },
            },
            option.label,
          ),
        ),
      );
    }

    function projectSelect(projects, value, onChange, following = false) {
      return h(
        "select",
        {
          value: value ?? "",
          onChange: (event) =>
            onChange(event.target.value === "" ? null : event.target.value),
          title: following
            ? `Filter by project — following this session's workspace (${value})`
            : "Filter by project",
          style: {
            height: 28,
            padding: "0 8px",
            borderRadius: 8,
            border: `1px solid ${T.border1}`,
            background: T.layer1,
            color: T.text,
            font: "500 11.5px/1 inherit",
            cursor: "pointer",
            maxWidth: 170,
          },
        },
        h("option", { value: "" }, "All projects"),
        ...projects.map((project) =>
          h("option", { key: project, value: project }, project),
        ),
      );
    }

    function searchInput(value, onChange) {
      return h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            flex: "1 1 160px",
            minWidth: 140,
          },
        },
        h(
          "label",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 6,
              width: "100%",
              height: 28,
              padding: "0 8px",
              borderRadius: 8,
              border: `1px solid ${T.border1}`,
              background: T.layer1,
            },
          },
          h(
            "svg",
            {
              width: 13,
              height: 13,
              viewBox: "0 0 24 24",
              "aria-hidden": true,
              style: { flex: "0 0 auto", opacity: 0.6 },
            },
            h("circle", {
              cx: 11,
              cy: 11,
              r: 7,
              fill: "none",
              stroke: "currentColor",
              strokeWidth: 2,
            }),
            h("path", {
              d: "M16.5 16.5 21 21",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: 2,
              strokeLinecap: "round",
            }),
          ),
          h("input", {
            value,
            onChange: (event) => onChange(event.target.value),
            placeholder: "Filter cards…",
            "aria-label": "Filter cards",
            style: {
              flex: "1 1 auto",
              minWidth: 0,
              border: "none",
              outline: "none",
              background: "transparent",
              color: T.text,
              font: "400 12px/1 inherit",
            },
          }),
          value === ""
            ? null
            : h(
                "button",
                {
                  type: "button",
                  onClick: () => onChange(""),
                  title: "Clear filter",
                  style: {
                    border: "none",
                    background: "transparent",
                    color: T.text3,
                    cursor: "pointer",
                    font: "500 13px/1 inherit",
                    padding: 0,
                  },
                },
                "×",
              ),
        ),
      );
    }

    /* ---------------------------------- cards --------------------------------- */

    /** One font for every meta mark: scope, id, priority, counts and owner. */
    const META_FONT =
      "500 10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace";

    /** A compact priority label: HIGH is loud, NORMAL/LOW stay quiet. */
    function priorityBadge(card) {
      const priority = card.priority ?? "normal";
      const high = priority === "high";
      return h(
        "span",
        {
          "data-priority": priority,
          title: `${priority} priority`,
          style: {
            flex: "0 0 auto",
            padding: high ? "0 4px" : "0 2px",
            borderRadius: 4,
            border: high
              ? `1px solid color-mix(in srgb, ${T.danger} 32%, transparent)`
              : "none",
            background: high
              ? `color-mix(in srgb, ${T.danger} 9%, transparent)`
              : "none",
            color: high ? T.danger : T.text3,
            font: META_FONT,
            letterSpacing: "0.02em",
            opacity: priority === "low" ? 0.65 : 1,
          },
        },
        priority === "high" ? "HIGH" : priority === "low" ? "LOW" : "NORMAL",
      );
    }

    /* ------------------------------- markdown ------------------------------- */

    /**
     * A deliberately small Markdown renderer for card bodies.
     *
     * Card bodies are Markdown written for terminals and the Web UI; the panel
     * used to print the source in a monospace box. This handles the constructs
     * cards actually use (headings, lists, task boxes, fenced/inline code,
     * emphasis, links, quotes, tables, rules) and returns React elements, so
     * text is escaped by the renderer — no `dangerouslySetInnerHTML`, no raw
     * HTML support.
     */
    function inlineMarkdown(text, accent) {
      const out = [];
      let index = 0;
      let key = 0;
      const push = (value) => {
        if (value !== "") out.push(value);
      };
      while (index < text.length) {
        const char = text[index];
        if (char === "`") {
          const end = text.indexOf("`", index + 1);
          if (end > index) {
            out.push(
              h(
                "code",
                {
                  key: key++,
                  style: {
                    font: "500 10.5px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace",
                    background: T.layer2,
                    border: `1px solid ${T.border1}`,
                    borderRadius: 4,
                    padding: "0 3px",
                  },
                },
                text.slice(index + 1, end),
              ),
            );
            index = end + 1;
            continue;
          }
        }
        if (text.startsWith("**", index) || text.startsWith("__", index)) {
          const mark = text.slice(index, index + 2);
          const end = text.indexOf(mark, index + 2);
          if (end > index + 2) {
            out.push(
              h(
                "strong",
                { key: key++, style: { fontWeight: 650 } },
                ...inlineMarkdown(text.slice(index + 2, end), accent),
              ),
            );
            index = end + 2;
            continue;
          }
        }
        if (char === "*" || char === "_") {
          const end = text.indexOf(char, index + 1);
          if (end > index + 1) {
            out.push(
              h(
                "em",
                { key: key++ },
                ...inlineMarkdown(text.slice(index + 1, end), accent),
              ),
            );
            index = end + 1;
            continue;
          }
        }
        if (char === "[") {
          const close = text.indexOf("]", index + 1);
          const open = close + 1;
          if (close > index && text[open] === "(") {
            const closeParen = text.indexOf(")", open + 1);
            if (closeParen > open) {
              const label = text.slice(index + 1, close);
              const href = text.slice(open + 1, closeParen).trim();
              if (/^(https?:\/\/|mailto:|#)/iu.test(href)) {
                out.push(
                  h(
                    "a",
                    {
                      key: key++,
                      href,
                      target: "_blank",
                      rel: "noreferrer",
                      style: { color: T.business, textDecoration: "underline" },
                    },
                    ...inlineMarkdown(label, accent),
                  ),
                );
                index = closeParen + 1;
                continue;
              }
              // A relative path is a repo document, not a panel URL: keep the
              // label but do not create a dead link.
              out.push(...inlineMarkdown(label, accent));
              index = closeParen + 1;
              continue;
            }
          }
        }
        let end = index + 1;
        while (end < text.length && "`*_[".indexOf(text[end]) === -1) end += 1;
        push(text.slice(index, end));
        index = end;
      }
      return out;
    }

    const MD_LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u;
    const MD_HEADING = /^(#{1,6})\s+(.*)$/u;
    const MD_FENCE = /^\s*```([\w-]*)\s*$/u;
    const MD_RULE = /^\s*(---|\*\*\*|___)\s*$/u;
    const MD_TABLE_SEPARATOR =
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/u;

    function markdownBlocks(source, accent) {
      const lines = String(source).replace(/\r\n?/gu, "\n").split("\n");
      const blocks = [];
      let index = 0;
      let key = 0;
      const paragraphStyle = { margin: "0 0 7px", lineHeight: 1.6 };
      const headingStyle = (level) => ({
        margin: level <= 2 ? "10px 0 4px" : "8px 0 3px",
        font: `650 ${level === 1 ? 15 : level === 2 ? 13.5 : 12.5}px/1.35 inherit`,
        color: T.text,
      });
      const isBlank = (line) => line.trim() === "";
      const startsBlock = (line) =>
        MD_FENCE.test(line) ||
        MD_HEADING.test(line) ||
        MD_RULE.test(line) ||
        MD_LIST.test(line) ||
        /^\s*>/u.test(line) ||
        (line.includes("|") &&
          index + 1 < lines.length &&
          MD_TABLE_SEPARATOR.test(lines[index + 1]));

      while (index < lines.length) {
        const line = lines[index];
        if (isBlank(line)) {
          index += 1;
          continue;
        }

        const fence = MD_FENCE.exec(line);
        if (fence) {
          const code = [];
          index += 1;
          while (index < lines.length && !/^\s*```\s*$/u.test(lines[index])) {
            code.push(lines[index]);
            index += 1;
          }
          index += 1;
          blocks.push(
            h(
              "pre",
              {
                key: key++,
                style: {
                  margin: "0 0 7px",
                  padding: "7px 9px",
                  borderRadius: 6,
                  border: `1px solid ${T.border1}`,
                  background: T.layer2,
                  overflow: "auto",
                  maxHeight: 320,
                },
              },
              h(
                "code",
                {
                  style: {
                    font: "400 10.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
                    whiteSpace: "pre",
                  },
                },
                code.join("\n"),
              ),
            ),
          );
          continue;
        }

        const heading = MD_HEADING.exec(line);
        if (heading) {
          const level = Math.min(heading[1].length, 6);
          const tag = `h${level}`;
          blocks.push(
            h(
              tag,
              { key: key++, style: headingStyle(level) },
              ...inlineMarkdown(heading[2], accent),
            ),
          );
          index += 1;
          continue;
        }

        if (MD_RULE.test(line)) {
          blocks.push(
            h("hr", {
              key: key++,
              style: {
                border: 0,
                borderTop: `1px solid ${T.border2}`,
                margin: "8px 0",
              },
            }),
          );
          index += 1;
          continue;
        }

        if (
          line.includes("|") &&
          index + 1 < lines.length &&
          MD_TABLE_SEPARATOR.test(lines[index + 1])
        ) {
          const cells = (row) =>
            row
              .replace(/^\s*\|/u, "")
              .replace(/\|\s*$/u, "")
              .split("|")
              .map((cell) => cell.trim());
          const header = cells(line);
          index += 2;
          const rows = [];
          while (
            index < lines.length &&
            lines[index].includes("|") &&
            !isBlank(lines[index])
          ) {
            rows.push(cells(lines[index]));
            index += 1;
          }
          const cellStyle = {
            border: `1px solid ${T.border1}`,
            padding: "3px 6px",
            textAlign: "left",
            verticalAlign: "top",
            font: "400 11px/1.45 inherit",
          };
          blocks.push(
            h(
              "table",
              {
                key: key++,
                style: {
                  borderCollapse: "collapse",
                  margin: "0 0 8px",
                  width: "100%",
                  tableLayout: "auto",
                },
              },
              h(
                "thead",
                null,
                h(
                  "tr",
                  null,
                  ...header.map((cell, cellIndex) =>
                    h(
                      "th",
                      {
                        key: cellIndex,
                        style: {
                          ...cellStyle,
                          background: T.layer1,
                          fontWeight: 650,
                        },
                      },
                      ...inlineMarkdown(cell, accent),
                    ),
                  ),
                ),
              ),
              h(
                "tbody",
                null,
                ...rows.map((row, rowIndex) =>
                  h(
                    "tr",
                    { key: rowIndex },
                    ...row.map((cell, cellIndex) =>
                      h(
                        "td",
                        { key: cellIndex, style: cellStyle },
                        ...inlineMarkdown(cell, accent),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
          continue;
        }

        if (/^\s*>/u.test(line)) {
          const quote = [];
          while (index < lines.length && /^\s*>/u.test(lines[index])) {
            quote.push(lines[index].replace(/^\s*>\s?/u, ""));
            index += 1;
          }
          blocks.push(
            h(
              "blockquote",
              {
                key: key++,
                style: {
                  margin: "0 0 7px",
                  padding: "2px 0 2px 9px",
                  borderLeft: `3px solid ${T.border3}`,
                  color: T.text2,
                },
              },
              ...markdownBlocks(quote.join("\n"), accent),
            ),
          );
          continue;
        }

        const list = MD_LIST.exec(line);
        if (list) {
          const ordered = /^\d/u.test(list[2]);
          const items = [];
          while (index < lines.length) {
            const item = MD_LIST.exec(lines[index]);
            if (!item || /^\d/u.test(item[2]) !== ordered) break;
            const indent = item[1].length;
            let content = item[3];
            index += 1;
            while (
              index < lines.length &&
              /^\s{2,}\S/u.test(lines[index]) &&
              !MD_LIST.test(lines[index])
            ) {
              content += ` ${lines[index].trim()}`;
              index += 1;
            }
            const task = /^\[([ xX])\]\s+(.*)$/u.exec(content);
            const body = task === null ? content : task[2];
            items.push(
              h(
                "li",
                {
                  key: key++,
                  style: {
                    margin: "2px 0",
                    marginLeft: Math.min(indent, 4) * 4,
                  },
                },
                task === null
                  ? null
                  : h("input", {
                      type: "checkbox",
                      checked: task[1].toLowerCase() === "x",
                      disabled: true,
                      style: { margin: "0 5px 0 0", verticalAlign: "middle" },
                    }),
                ...inlineMarkdown(body, accent),
              ),
            );
          }
          blocks.push(
            h(
              ordered ? "ol" : "ul",
              { key: key++, style: { margin: "0 0 7px", paddingLeft: 20 } },
              ...items,
            ),
          );
          continue;
        }

        const paragraph = [];
        while (
          index < lines.length &&
          !isBlank(lines[index]) &&
          !startsBlock(lines[index])
        ) {
          paragraph.push(lines[index].trim());
          index += 1;
        }
        blocks.push(
          h(
            "p",
            { key: key++, style: paragraphStyle },
            ...inlineMarkdown(paragraph.join(" "), accent),
          ),
        );
      }
      return blocks;
    }

    function detailBlock(detail, accent) {
      if (detail === undefined || detail === null) {
        return h(
          "div",
          { style: { font: "400 11.5px/1.4 inherit", color: T.text3 } },
          "Loading card…",
        );
      }
      if (detail.status === "error") {
        return h(
          "div",
          { style: { font: "400 11.5px/1.4 inherit", color: T.danger } },
          detail.error,
        );
      }
      const fields = detail.fields ?? {};
      const chips = [];
      if (fields["parent"]) chips.push(chip(fields["parent"], { mono: true }));
      if (fields["blocked by"] && fields["blocked by"] !== "—")
        chips.push(
          chip(`blocked by ${fields["blocked by"]}`, { color: T.warn }),
        );
      if (fields["created by"])
        chips.push(chip(`by ${fields["created by"].split(" · ")[0]}`));
      return h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginTop: 6,
            // Follow the host theme: the base surface is white in light mode
            // and the dark surface in dark mode. The column accent stays on the
            // row/border, not on the reading surface.
            background: T.base,
            border: `1px solid ${T.border1}`,
            borderRadius: 8,
            padding: "6px 8px",
          },
        },
        chips.length > 0
          ? h(
              "div",
              { style: { display: "flex", gap: 4, flexWrap: "wrap" } },
              ...chips,
            )
          : null,
        detail.body
          ? h(
              "div",
              {
                style: {
                  overflowWrap: "anywhere",
                  font: "400 12px/1.6 inherit",
                  color: T.text2,
                  maxHeight: 420,
                  overflow: "auto",
                },
              },
              ...markdownBlocks(detail.body, accent),
            )
          : h(
              "div",
              { style: { font: "400 11.5px/1.4 inherit", color: T.text3 } },
              "No body.",
            ),
        detail.history
          ? h(
              "details",
              { style: { font: "400 11px/1.4 inherit", color: T.text3 } },
              h("summary", { style: { cursor: "pointer" } }, "History"),
              h(
                "pre",
                {
                  style: {
                    margin: "4px 0 0",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    font: "400 10.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
                    color: T.text3,
                    maxHeight: 180,
                    overflow: "auto",
                  },
                },
                detail.history,
              ),
            )
          : null,
      );
    }

    /** `project/subproject`, or just `project`; null when the card names none. */
    function cardScope(card) {
      if (typeof card.project !== "string" || card.project === "") return null;
      return typeof card.subproject === "string" && card.subproject !== ""
        ? `${card.project}/${card.subproject}`
        : card.project;
    }

    /**
     * One row per card, children under their umbrella when they share a column.
     *
     * A part follows its umbrella at any depth *within the same state*. A part
     * in another state (an umbrella still doing, a part already done or in
     * review) is drawn at the top of its own column and wears `⤷#parent`: the
     * columns and their counts must answer "what is in this state", not "what
     * belongs to this umbrella". A card whose umbrella is filtered out stays a
     * root too.
     */
    function rowsByState(board) {
      const sectionOf = new Map();
      for (const state of STATES)
        for (const card of board[state]) sectionOf.set(card.id, state);
      const childrenOf = new Map();
      const roots = [];
      for (const state of STATES) {
        for (const card of board[state]) {
          const parent = typeof card.parent === "number" ? card.parent : null;
          if (parent !== null && parent !== card.id && sectionOf.has(parent)) {
            const list = childrenOf.get(parent) ?? [];
            list.push(card);
            childrenOf.set(parent, list);
          } else {
            roots.push(card);
          }
        }
      }

      const updatedMs = (card) => {
        const parsed = Date.parse(card?.updatedAt ?? "");
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const newestFirst = (left, right) =>
        updatedMs(right.card) - updatedMs(left.card);
      for (const list of childrenOf.values()) {
        list.sort((left, right) => updatedMs(right) - updatedMs(left));
      }

      // A group is one root plus the same-state parts drawn under it. A part in
      // another state starts a group in its own column, so every column can be
      // sorted by recency without breaking the umbrella tree it belongs to.
      const groups = new Map(STATES.map((state) => [state, []]));
      const seen = new Set();
      const build = (card, depth, parentState) => {
        if (seen.has(card.id)) return null;
        seen.add(card.id);
        const own = sectionOf.get(card.id) ?? card.state;
        const sameColumn = own === parentState;
        const node = {
          card,
          depth: sameColumn ? depth : 0,
          state: own,
          children: [],
        };
        if (!sameColumn) groups.get(own).push(node);
        for (const child of childrenOf.get(card.id) ?? []) {
          const built = build(child, node.depth + 1, own);
          if (built !== null && built.state === own) node.children.push(built);
        }
        return node;
      };

      for (const root of roots) {
        const node = build(root, 0, sectionOf.get(root.id) ?? root.state);
        if (node !== null) groups.get(node.state).push(node);
      }
      // A parent cycle leaves cards that are nobody's root; keep them visible.
      for (const state of STATES) {
        for (const card of board[state]) {
          if (seen.has(card.id)) continue;
          const node = build(card, 0, state);
          if (node !== null) groups.get(node.state).push(node);
        }
      }

      const rows = new Map(STATES.map((state) => [state, []]));
      const flatten = (node, out) => {
        out.push({ card: node.card, depth: node.depth, state: node.state });
        for (const child of node.children) flatten(child, out);
      };
      for (const state of STATES) {
        const out = rows.get(state);
        for (const group of groups.get(state).sort(newestFirst))
          flatten(group, out);
      }
      return rows;
    }

    /**
     * `⤷#38` for an orphan's umbrella, `▸4/6` for an umbrella's progress.
     * A nested row sits under its umbrella already, so it drops the first.
     */
    function hierarchySuffix(card, byId, nested) {
      const parts = [];
      if (!nested && typeof card.parent === "number")
        parts.push(`⤷#${card.parent}`);
      const children = Array.isArray(card.children) ? card.children : [];
      if (children.length > 0) {
        const resolved =
          byId === undefined
            ? []
            : children
                .map((id) => byId.get(id))
                .filter((child) => child !== undefined);
        parts.push(
          resolved.length === children.length
            ? `▸${resolved.filter((child) => child.state === "done").length}/${children.length}`
            : `▸${children.length}`,
        );
      }
      return parts.length > 0 ? parts.join(" ") : null;
    }

    /**
     * One card on one line: scope, id, title, then the right-hand marks.
     *
     * The row replaced a two-column grid of block cards; density is the point, so
     * the title never wraps (it ellipses) and everything else is a fixed-width
     * mark. Clicking still expands the card's `ukb show` body beneath the line.
     */
    function cardLine(row, options) {
      const card = row.card;
      const depth = row.depth;
      const compact = options?.compact === true;
      const expanded = options?.expanded === true;
      const accent = options?.accent ?? T.text3;
      const sectionState = options?.state ?? row.state;
      const noteCount = Array.isArray(card.notes) ? card.notes.length : 0;
      const blocked = Array.isArray(card.blockedBy) ? card.blockedBy.length : 0;
      const scope = cardScope(card);
      const hierarchy = hierarchySuffix(card, options?.byId, depth > 0);
      const owner =
        row.state === "doing"
          ? `@${card.assignee ?? "unassigned"}`
          : row.state === "review"
            ? card.reviewer
              ? `→ ${card.reviewer}`
              : null
            : card.assignee
              ? `@${card.assignee}`
              : null;

      const line = h(
        "div",
        {
          key: String(card.id),
          "data-card": card.id,
          "data-depth": depth,
          role: "button",
          tabIndex: 0,
          title: typeof card.title === "string" ? card.title : "",
          onClick: () => options?.onToggleCard?.(card.id),
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              options?.onToggleCard?.(card.id);
            }
          },
          style: {
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
            marginLeft: depth === 0 ? 0 : 12,
            borderLeft: depth === 0 ? "none" : `1px solid ${T.border2}`,
            padding: compact ? "2px 6px" : "3px 7px",
            paddingLeft: depth === 0 ? 7 : 8,
            borderRadius: 7,
            background: expanded
              ? `color-mix(in srgb, ${accent} 9%, transparent)`
              : "transparent",
            cursor: "pointer",
            whiteSpace: "nowrap",
            overflow: "hidden",
          },
          onMouseEnter: (event) => {
            if (!expanded) event.currentTarget.style.background = T.hover;
          },
          onMouseLeave: (event) => {
            if (!expanded) event.currentTarget.style.background = "transparent";
          },
        },
        row.state !== sectionState
          ? h("span", {
              title: STATE_LABEL[row.state] ?? row.state,
              style: {
                width: 6,
                height: 6,
                borderRadius: 999,
                flex: "0 0 auto",
                background: STATE_COLOR[row.state] ?? T.text3,
              },
            })
          : null,
        scope !== null
          ? h(
              "span",
              {
                "data-scope": scope,
                title: scope,
                style: {
                  flex: "0 0 auto",
                  maxWidth: 150,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  padding: "0 5px",
                  borderRadius: 5,
                  border: `1px solid ${T.border1}`,
                  background: T.layer1,
                  color: T.text2,
                  font: META_FONT,
                },
              },
              scope,
            )
          : null,
        h(
          "span",
          {
            "data-card-id": card.id,
            title: `card #${card.id}`,
            style: {
              flex: "0 0 auto",
              padding: "0 4px",
              borderRadius: 5,
              border: `1px solid color-mix(in srgb, ${accent} 26%, ${T.border1})`,
              background: `color-mix(in srgb, ${accent} 8%, transparent)`,
              color: T.text2,
              font: META_FONT,
              fontVariantNumeric: "tabular-nums",
            },
          },
          `#${card.id}`,
        ),
        priorityBadge(card),
        h(
          "span",
          {
            style: {
              flex: "1 1 auto",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: T.text,
              font: `${row.state === "doing" ? 500 : 400} ${compact ? 11.5 : 12}px/1.4 inherit`,
            },
          },
          typeof card.title === "string" ? card.title : "",
        ),
        hierarchy !== null
          ? h(
              "span",
              {
                style: {
                  flex: "0 0 auto",
                  font: META_FONT,
                  color: T.text3,
                },
              },
              hierarchy,
            )
          : null,
        blocked > 0
          ? h(
              "span",
              {
                style: {
                  flex: "0 0 auto",
                  font: META_FONT,
                  color: T.warn,
                },
              },
              `⛔${blocked}`,
            )
          : null,
        noteCount > 0
          ? h(
              "span",
              {
                style: {
                  flex: "0 0 auto",
                  font: META_FONT,
                  color: T.text3,
                },
              },
              `✎${noteCount}`,
            )
          : null,
        owner !== null
          ? h(
              "span",
              {
                style: {
                  flex: "0 0 auto",
                  font: META_FONT,
                  color: T.text2,
                },
              },
              owner,
            )
          : null,
      );

      if (!expanded) return line;
      return h(
        "div",
        {
          key: String(card.id),
          style: { display: "flex", flexDirection: "column" },
        },
        line,
        h(
          "div",
          {
            style: {
              marginLeft: depth === 0 ? 7 : 20,
              marginRight: 6,
              marginBottom: 4,
            },
          },
          detailBlock(options?.detail, accent),
        ),
      );
    }

    function section(state, rows, options) {
      const limit = options?.limit ?? 200;
      const shown = rows.slice(0, limit);
      const compact = options?.compact === true;
      const color = STATE_COLOR[state] ?? T.text3;
      const collapsed = options?.collapsed === true;

      return h(
        "section",
        {
          key: state,
          style: {
            display: "flex",
            flexDirection: "column",
            borderRadius: 12,
            border: `1px solid ${T.border1}`,
            borderLeft: `3px solid ${color}`,
            background: `color-mix(in srgb, ${color} 4%, ${T.base})`,
            overflow: "hidden",
          },
        },
        h(
          "div",
          {
            onClick: () => options?.onToggleSection?.(state),
            role: "button",
            tabIndex: 0,
            title: collapsed
              ? `Show ${STATE_LABEL[state]}`
              : `Collapse ${STATE_LABEL[state]}`,
            style: {
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "7px 10px",
              cursor: "pointer",
              background: `color-mix(in srgb, ${color} 12%, ${T.base})`,
              borderBottom: collapsed ? "none" : `1px solid ${T.border1}`,
              position: "sticky",
              top: 0,
              zIndex: 1,
              backdropFilter: "blur(6px)",
            },
          },
          h("span", {
            style: {
              width: 8,
              height: 8,
              borderRadius: 999,
              background: color,
              flex: "0 0 auto",
            },
          }),
          h(
            "span",
            {
              style: {
                font: "700 11px/1.2 inherit",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color,
              },
            },
            STATE_LABEL[state] ?? state,
          ),
          h(
            "span",
            {
              style: {
                font: "600 10.5px/1 inherit",
                color,
                background: `color-mix(in srgb, ${color} 16%, transparent)`,
                border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
                borderRadius: 999,
                padding: "1px 6px",
              },
            },
            String(rows.length),
          ),
          h("span", { style: { flex: "1 1 auto" } }),
          h(
            "span",
            { style: { font: "600 10px/1 inherit", color: T.text3 } },
            collapsed ? "▸" : "▾",
          ),
        ),
        collapsed
          ? null
          : h(
              "div",
              {
                style: {
                  display: "flex",
                  flexDirection: "column",
                  gap: compact ? 0 : 1,
                  padding: "4px 5px",
                  alignContent: "start",
                },
              },
              shown.length === 0
                ? h(
                    "div",
                    {
                      style: {
                        padding: "8px 8px",
                        borderRadius: 7,
                        border: `1px dashed ${T.border1}`,
                        color: T.caption,
                        font: "400 11.5px/1.3 inherit",
                        textAlign: "center",
                      },
                    },
                    "Empty",
                  )
                : null,
              ...shown.map((row) =>
                cardLine(row, {
                  ...options,
                  accent: color,
                  state,
                  expanded: options?.expandedId === row.card.id,
                  detail: options?.detail,
                  onToggleCard: options?.onToggleCard,
                }),
              ),
              rows.length > shown.length
                ? h(
                    "div",
                    {
                      style: {
                        font: "400 11px/1.4 inherit",
                        color: T.text3,
                        paddingLeft: 4,
                      },
                    },
                    `+${rows.length - shown.length} more`,
                  )
                : null,
            ),
      );
    }

    function boardView(board, options) {
      const rows = rowsByState(board);
      const byId = new Map();
      for (const state of STATES)
        for (const card of board[state]) byId.set(card.id, card);
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 12 } },
        ...STATES.map((state) =>
          section(state, rows.get(state) ?? [], {
            ...options,
            byId,
            limit: options?.limit ?? STATE_LIMIT[state] ?? 200,
            collapsed: options?.collapsedStates?.has(state) === true,
          }),
        ),
      );
    }

    /** A board object is `{ someday, todo, doing, review, done }` of card arrays. */
    function boardOf(value) {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return null;
      for (const state of STATES) {
        if (!Array.isArray(value[state])) return null;
      }
      return value;
    }

    /* ---------------------------------- glyphs -------------------------------- */

    /**
     * The guide's placeholder cube is only for entries without an icon. The
     * contract is `({ size?: number, className?: string })`; the guide passes a
     * size, so the glyph only needs to fill it with currentColor.
     */
    function KanbanGlyph({ size = 22, className } = {}) {
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          className,
          "aria-hidden": true,
          style: { display: "block" },
        },
        h("rect", {
          x: 3,
          y: 4,
          width: 5,
          height: 16,
          rx: 1.4,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
        }),
        h("rect", {
          x: 9.5,
          y: 4,
          width: 5,
          height: 10,
          rx: 1.4,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
        }),
        h("rect", {
          x: 16,
          y: 4,
          width: 5,
          height: 13,
          rx: 1.4,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
        }),
      );
    }

    /* ---------------------------------- data ---------------------------------- */

    /**
     * Candidate URLs for a Host route. The app may be served from a sub-path,
     * from `dsh-app://app/`, or with an SPA route already in `document.baseURI`;
     * the first candidate that answers JSON wins.
     */
    function routeUrls(path, params = {}) {
      const bases = [];
      try {
        bases.push(document.baseURI);
      } catch {
        /* no document base */
      }
      try {
        if (location.origin && location.origin !== "null")
          bases.push(`${location.origin}/`);
      } catch {
        /* no origin */
      }
      try {
        bases.push(location.href);
      } catch {
        /* no location */
      }
      const paths = [];
      for (const base of bases) {
        try {
          paths.push(new URL(path, base).toString());
        } catch {
          // A base that cannot be parsed simply contributes no candidate.
        }
      }
      try {
        paths.push(new URL(`/${path}`, location.origin).toString());
      } catch {
        // `file:` and similar origins have no usable origin.
      }
      return [...new Set(paths)].map((href) => {
        const url = new URL(href);
        for (const [name, value] of Object.entries(params)) {
          if (value !== null && value !== undefined && value !== "") {
            url.searchParams.set(name, String(value));
          }
        }
        return url.toString();
      });
    }

    /** Candidate URLs for the board route. */
    function boardUrls(project) {
      return routeUrls("api/ukb/board", { project });
    }

    /** One JSON answer from the first candidate that speaks JSON. */
    async function readBoardJson(project) {
      const tried = [];
      for (const url of boardUrls(project)) {
        tried.push(url);
        try {
          const response = await fetch(url, {
            headers: { accept: "application/json" },
          });
          const text = await response.text();
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            continue;
          }
          if (body && typeof body === "object" && body.error) {
            return { ok: false, error: String(body.error), tried };
          }
          if (!response.ok) continue;
          return { ok: true, body, tried };
        } catch {
          // Try the next candidate.
        }
      }
      return {
        ok: false,
        error: `no candidate answered JSON; tried ${tried.join(", ")}`,
        tried,
      };
    }

    /** Candidate URLs for the card-detail route, same resolution as the board. */
    function cardUrls(id) {
      return routeUrls("api/ukb/card", { id });
    }

    /** `ukb show <id>` as `{ status, fields, body, history }`, or an error. */
    async function readCardJson(id) {
      const tried = [];
      for (const url of cardUrls(id)) {
        tried.push(url);
        try {
          const response = await fetch(url, {
            headers: { accept: "application/json" },
          });
          const text = await response.text();
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            continue;
          }
          if (body && typeof body === "object" && body.error)
            return { ok: false, error: String(body.error) };
          if (!response.ok || typeof body.text !== "string") continue;
          return { ok: true, body };
        } catch {
          // Try the next candidate.
        }
      }
      return {
        ok: false,
        error: `no candidate answered; tried ${tried.join(", ")}`,
      };
    }

    /**
     * Ask the Host to start (or reuse) the full board UI and hand back its URL.
     *
     * One GET on `api/ukb/web`: the Host starts `ukb web` detached when no
     * server is running, opens the configured remote board when the CLI points
     * at one, or answers the server it already started. The URL carries the
     * server's per-launch token, which is why the page cannot build it itself.
     */
    async function startFullBoard() {
      const tried = [];
      for (const url of routeUrls("api/ukb/web")) {
        tried.push(url);
        try {
          const response = await fetch(url, {
            headers: { accept: "application/json" },
          });
          const text = await response.text();
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            continue;
          }
          if (
            body &&
            typeof body === "object" &&
            typeof body.url === "string" &&
            body.url !== ""
          ) {
            return {
              ok: true,
              url: body.url,
              mode: typeof body.mode === "string" ? body.mode : "local",
              reused: body.reused === true,
              tried,
            };
          }
          if (body && typeof body === "object" && body.error) {
            return { ok: false, error: String(body.error), tried };
          }
          if (!response.ok) continue;
        } catch {
          // Try the next candidate.
        }
      }
      return {
        ok: false,
        error: `no candidate answered JSON; tried ${tried.join(", ")}`,
        tried,
      };
    }

    /**
     * Parse `ukb show`: a `#id title [state]` head, `key: value` lines, then an
     * indented `body:` section and whatever follows it (history).
     */
    function parseShow(text) {
      const lines = String(text).split("\n");
      const head = /^#(\d+)\s+(.*?)\s+\[([a-z]+)\]$/u.exec(lines[0] ?? "");
      const fields = {};
      const body = [];
      const history = [];
      let sectionName = "";
      for (
        let index = head === null ? 0 : 1;
        index < lines.length;
        index += 1
      ) {
        const line = lines[index];
        const field = /^([a-z][a-z ]*):\s*(.*)$/u.exec(line);
        if (field !== null) {
          sectionName = field[1];
          fields[sectionName] = field[2];
          continue;
        }
        if (sectionName === "body") body.push(line.replace(/^ {2}/u, ""));
        else if (sectionName === "history")
          history.push(line.replace(/^ {2}/u, ""));
      }
      return {
        status: "ready",
        title: head?.[2] ?? "",
        state: head?.[3] ?? "",
        fields,
        body: body.join("\n").trim(),
        history: history.join("\n").trim(),
      };
    }

    function useBoard() {
      const [state, setState] = useState({
        status: "loading",
        board: null,
        identity: null,
        error: null,
        at: null,
      });
      const [nonce, setNonce] = useState(0);
      const refresh = useCallback(() => setNonce((value) => value + 1), []);
      useEffect(() => {
        let alive = true;
        const read = async () => {
          const result = await readBoardJson(null);
          if (!alive) return;
          if (!result.ok) {
            setState({
              status: "error",
              board: null,
              identity: null,
              error: result.error,
              at: null,
            });
            return;
          }
          const board = boardOf(result.body);
          setState({
            status: board === null ? "error" : "ready",
            board,
            identity: result.body.identity ?? null,
            error: board === null ? "unexpected board payload" : null,
            at: Date.now(),
          });
        };
        void read();
        const timer = setInterval(read, 20_000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [nonce]);
      return { ...state, refresh };
    }

    /* -------------------------------- workspace ------------------------------- */

    /**
     * The Session's working directory, read from the slot props.
     *
     * Slot props are the only place a client plugin may read session data; the
     * sidebar tab is session-scoped, so the hook is present in the real page.
     * A host that hands over no seats still renders the panel unscoped rather
     * than blanking the slot.
     */
    function useSessionCwd(props = {}) {
      const useSessions =
        typeof props.useSessions === "function"
          ? props.useSessions
          : () => undefined;
      return useSessions((state) =>
        props.sessionId ? state.byId[props.sessionId]?.cwd : undefined,
      );
    }

    /**
     * The board project a working directory belongs to: the deepest path segment
     * that names one of the board's projects.
     *
     * Deepest, so a Session opened in `…/using-kanban/packages/dsh` still lands on
     * `using-kanban`; whole-segment equality only, so `using-kanban-tools` is not
     * mistaken for `using-kanban`. No match means "no workspace project" and the
     * panel keeps the whole board.
     *
     * @param {string | undefined} cwd
     * @param {readonly string[]} projects
     * @returns {string | null}
     */
    function projectFromWorkspace(cwd, projects) {
      if (typeof cwd !== "string" || cwd === "" || !Array.isArray(projects))
        return null;
      /** @type {Map<string, string>} */
      const known = new Map();
      for (const name of projects) {
        if (typeof name === "string" && name !== "")
          known.set(name.toLowerCase(), name);
      }
      if (known.size === 0) return null;
      const segments = cwd.split(/[\\/]+/);
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        const segment = segments[index];
        if (segment === "" || segment === "." || segment === "..") continue;
        const hit = known.get(segment.toLowerCase());
        if (hit !== undefined) return hit;
      }
      return null;
    }

    /* --------------------------------- filters -------------------------------- */

    const SCOPES = [
      { value: "all", label: "All" },
      { value: "mine", label: "Mine", title: "Cards assigned to you" },
      { value: "agent", label: "Agent", title: "Cards assigned to the agent" },
      { value: "review", label: "Review", title: "Waiting for your review" },
    ];

    function projectsOf(board) {
      const names = new Set();
      for (const state of STATES) {
        for (const card of board[state]) {
          if (typeof card.project === "string" && card.project !== "")
            names.add(card.project);
        }
      }
      return [...names].sort((a, b) => a.localeCompare(b));
    }

    function matches(card, filters, identity) {
      if (filters.project !== null && card.project !== filters.project)
        return false;
      const owner = identity?.owner ?? null;
      const agent = identity?.agent ?? null;
      if (
        filters.scope === "mine" &&
        (owner === null || card.assignee !== owner)
      )
        return false;
      if (
        filters.scope === "agent" &&
        (agent === null || card.assignee !== agent)
      )
        return false;
      if (filters.scope === "review") {
        if (card.state !== "review") return false;
        if (
          owner !== null &&
          card.reviewer !== null &&
          card.reviewer !== undefined &&
          card.reviewer !== owner
        )
          return false;
      }
      const query = filters.query.trim().toLowerCase();
      if (query !== "") {
        const haystack =
          `${card.id} ${card.title ?? ""} ${card.project ?? ""} ${card.assignee ?? ""}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    }

    function applyFilters(board, filters, identity) {
      const out = {};
      for (const state of STATES)
        out[state] = board[state].filter((card) =>
          matches(card, filters, identity),
        );
      return out;
    }

    function countOf(board) {
      return STATES.reduce((sum, state) => sum + board[state].length, 0);
    }

    function readDensity() {
      try {
        return globalThis.localStorage?.getItem(DENSITY_KEY) === "compact";
      } catch {
        return false;
      }
    }

    function writeDensity(compact) {
      try {
        globalThis.localStorage?.setItem(
          DENSITY_KEY,
          compact ? "compact" : "comfortable",
        );
      } catch {
        // Storage may be unavailable; density simply does not persist.
      }
    }

    /* ------------------------------- full board ------------------------------- */

    /** A blank tab opened inside the click handler, or null when blocked. */
    function openBlankTab() {
      try {
        return typeof window === "undefined" ||
          typeof window.open !== "function"
          ? null
          : window.open("about:blank", "_blank");
      } catch {
        return null;
      }
    }

    /** Send the blank tab to `url`, or fall back to a programmatic link click. */
    function openInTab(tab, url) {
      if (tab !== null && tab !== undefined) {
        try {
          tab.opener = null;
          tab.location.replace(url);
          return true;
        } catch {
          // A tab the host closed in the meantime: fall through.
        }
      }
      try {
        if (
          typeof document === "undefined" ||
          typeof document.createElement !== "function"
        ) {
          return false;
        }
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.click();
        return true;
      } catch {
        return false;
      }
    }

    function closeTab(tab) {
      try {
        tab?.close?.();
      } catch {
        // The tab is the host's; it may already be gone.
      }
    }

    /* ---------------------------------- panel --------------------------------- */

    function BoardPanel(props = {}) {
      const { status, board, identity, error, at, refresh } = useBoard();
      const cwd = useSessionCwd(props);
      const [query, setQuery] = useState("");
      // `undefined` follows this Session's workspace; `null` is the explicit All
      // projects choice, so a manual pick survives the 20s refresh.
      const [projectChoice, setProjectChoice] = useState(undefined);
      const [scope, setScope] = useState("all");
      const [compact, setCompact] = useState(readDensity);
      const [expandedId, setExpandedId] = useState(null);
      const [details, setDetails] = useState({});
      const [collapsedStates, setCollapsedStates] = useState(() => new Set());

      const [fullBoard, setFullBoard] = useState({ status: "idle" });

      const toggleCard = useCallback(
        (id) => {
          const opening = expandedId !== id;
          setExpandedId(opening ? id : null);
          if (!opening) return;
          if (details[id]?.status === "ready") return;
          setDetails((map) => ({ ...map, [id]: { status: "loading" } }));
          void readCardJson(id).then((result) => {
            setDetails((map) => ({
              ...map,
              [id]: result.ok
                ? parseShow(result.body.text)
                : { status: "error", error: result.error },
            }));
          });
        },
        [expandedId, details],
      );

      const toggleSection = useCallback((state) => {
        setCollapsedStates((current) => {
          const next = new Set(current);
          if (next.has(state)) next.delete(state);
          else next.add(state);
          return next;
        });
      }, []);

      /**
       * The full board (`ukb web`) in a new tab.
       *
       * The blank tab is opened inside the click handler on purpose: a tab
       * opened after the Host answers would be treated as a popup and blocked.
       * The Host starts the CLI on first use and answers the URL it printed.
       */
      const openFullBoard = useCallback(() => {
        if (fullBoard.status === "opening") return;
        const tab = openBlankTab();
        setFullBoard({ status: "opening" });
        void startFullBoard().then((result) => {
          if (!result.ok) {
            closeTab(tab);
            setFullBoard({ status: "error", error: result.error });
            return;
          }
          if (openInTab(tab, result.url)) {
            setFullBoard({ status: "idle" });
            return;
          }
          // The tab was blocked: leave the URL on screen as a real link.
          setFullBoard({
            status: "ready",
            url: result.url,
            mode: result.mode,
          });
        });
      }, [fullBoard.status]);

      const projects = useMemo(
        () => (board === null ? [] : projectsOf(board)),
        [board],
      );
      const workspaceProject = useMemo(
        () => projectFromWorkspace(cwd, projects),
        [cwd, projects],
      );
      const project =
        projectChoice === undefined ? workspaceProject : projectChoice;
      const filters = useMemo(
        () => ({ query, project, scope }),
        [query, project, scope],
      );
      const filtered = useMemo(
        () => (board === null ? null : applyFilters(board, filters, identity)),
        [board, filters, identity],
      );
      const total = filtered === null ? 0 : countOf(filtered);
      const grandTotal = board === null ? 0 : countOf(board);
      /** The visible board is narrowed — by a choice or by the workspace default. */
      const scoped = query !== "" || project !== null || scope !== "all";
      /** The reader has overridden a default, so Clear has something to restore. */
      const adjusted =
        query !== "" || projectChoice !== undefined || scope !== "all";

      const clearFilters = useCallback(() => {
        setQuery("");
        setProjectChoice(undefined);
        setScope("all");
      }, []);

      return h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            height: "100%",
            minHeight: 0,
            color: T.text,
          },
        },
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 14px 6px",
              flexWrap: "wrap",
            },
          },
          h(
            "span",
            {
              style: { font: "650 14px/1.2 inherit", letterSpacing: "-0.01em" },
            },
            "Kanban",
          ),
          h(
            "span",
            { style: { font: "500 11px/1 inherit", color: T.text3 } },
            scoped ? `${total} of ${grandTotal}` : `${grandTotal} cards`,
          ),
          at !== null
            ? h(
                "span",
                { style: { font: "400 10.5px/1 inherit", color: T.caption } },
                timeAgo(at),
              )
            : null,
          h("span", { style: { flex: "1 1 auto" } }),
          iconButton(
            compact ? "Comfortable" : "Compact",
            () => {
              const next = !compact;
              setCompact(next);
              writeDensity(next);
            },
            compact,
          ),
          iconButton("Refresh", refresh),
          iconButton(
            fullBoard.status === "opening" ? "Starting…" : "Full board ↗",
            openFullBoard,
          ),
        ),
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 14px 8px",
              flexWrap: "wrap",
              borderBottom: `1px solid ${T.border1}`,
            },
          },
          searchInput(query, setQuery),
          projectSelect(
            projects,
            project,
            setProjectChoice,
            projectChoice === undefined && workspaceProject !== null,
          ),
          segmented(SCOPES, scope, setScope),
          adjusted ? iconButton("Clear", clearFilters) : null,
        ),
        fullBoard.status === "error"
          ? footerNote(
              `Could not start the full board: ${fullBoard.error}`,
              T.warn,
            )
          : null,
        fullBoard.status === "ready"
          ? footerNote(
              h(
                "a",
                {
                  href: fullBoard.url,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  style: {
                    color: T.accent,
                    fontWeight: 500,
                    wordBreak: "break-all",
                  },
                },
                fullBoard.mode === "remote"
                  ? "Open the remote board ↗"
                  : "Open the full board ↗",
              ),
              T.text2,
            )
          : null,
        status === "loading"
          ? h(
              "div",
              {
                style: {
                  padding: "18px 14px",
                  font: "400 12px/1.5 inherit",
                  color: T.text3,
                },
              },
              "Reading the board…",
            )
          : null,
        status === "error"
          ? h(
              "div",
              {
                style: {
                  padding: "16px 14px",
                  font: "400 12px/1.5 inherit",
                  color: T.text2,
                },
              },
              `Could not read the board: ${error}`,
            )
          : null,
        status === "ready"
          ? h(
              "div",
              {
                style: {
                  flex: "1 1 auto",
                  minHeight: 0,
                  overflow: "auto",
                  padding: "10px 14px 14px",
                  scrollbarWidth: "thin",
                },
              },
              total === 0 && scoped
                ? h(
                    "div",
                    {
                      style: {
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: 8,
                        padding: "28px 0",
                        color: T.text3,
                      },
                    },
                    h(
                      "div",
                      { style: { font: "500 12.5px/1.4 inherit" } },
                      workspaceProject !== null && projectChoice === undefined
                        ? `No cards in ${workspaceProject}.`
                        : "No cards match these filters.",
                    ),
                    // The workspace default is the only filter here: clearing it
                    // would land on the same empty view, so offer the whole board.
                    workspaceProject !== null && projectChoice === undefined
                      ? iconButton("Show all projects", () =>
                          setProjectChoice(null),
                        )
                      : iconButton("Clear filters", clearFilters),
                  )
                : boardView(filtered, {
                    compact,
                    expandedId,
                    detail:
                      expandedId === null ? undefined : details[expandedId],
                    onToggleCard: toggleCard,
                    collapsedStates,
                    onToggleSection: toggleSection,
                  }),
            )
          : null,
      );
    }

    function timeAgo(timestamp) {
      const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
      if (seconds < 5) return "just now";
      if (seconds < 60) return `${seconds}s ago`;
      const minutes = Math.round(seconds / 60);
      return `${minutes}m ago`;
    }

    /** A one-line notice under the filter bar (a launch error, a blocked tab). */
    function footerNote(content, color) {
      return h(
        "div",
        {
          style: {
            padding: "8px 14px 0",
            font: "400 11.5px/1.45 inherit",
            color,
          },
        },
        content,
      );
    }

    /* ---------------------------------- chip ---------------------------------- */

    function BoardChip(props = {}) {
      const { status, board } = useBoard();
      const cwd = useSessionCwd(props);
      // The chip and the panel answer the same question — what is left here? —
      // so both read the Session workspace's project through the same rule. No
      // match means the whole board, which is what this chip always showed.
      const project = useMemo(
        () =>
          board === null ? null : projectFromWorkspace(cwd, projectsOf(board)),
        [board, cwd],
      );
      const open = useCallback(() => {
        try {
          ctxRef.current.sidebarRight.openTab(TAB_KIND);
        } catch (error) {
          console.warn("[ukb] could not open the board panel", error);
        }
      }, []);
      if (status !== "ready") return null;
      const counts = ["doing", "todo", "review"].map((state) => [
        state,
        board[state].filter(
          (card) => project === null || card.project === project,
        ).length,
      ]);
      if (counts.every(([, count]) => count === 0)) return null;
      return h(
        "button",
        {
          type: "button",
          onClick: open,
          title:
            project === null
              ? "Open the kanban board"
              : `Open the kanban board — ${project} (this workspace)`,
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            margin: "0 0 6px 2px",
            padding: "3px 9px",
            borderRadius: 999,
            border: `1px solid ${T.border1}`,
            background: T.layer1,
            color: T.text,
            font: "500 11px/1.2 inherit",
            cursor: "pointer",
          },
        },
        h("span", { style: { color: T.text3, fontWeight: 500 } }, "kanban"),
        project !== null
          ? h(
              "span",
              {
                style: {
                  font: META_FONT,
                  color: T.text3,
                  maxWidth: 110,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                },
              },
              project,
            )
          : null,
        ...counts.map(([state, count]) =>
          h(
            "span",
            {
              key: state,
              style: {
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                color: count === 0 ? T.caption : T.text,
              },
            },
            h("span", {
              style: {
                width: 5,
                height: 5,
                borderRadius: 999,
                background: STATE_COLOR[state],
                opacity: count === 0 ? 0.4 : 1,
              },
            }),
            `${STATE_LABEL[state].toLowerCase()} ${count}`,
          ),
        ),
      );
    }

    /* -------------------------------- tool view ------------------------------- */

    function textOf(value) {
      if (typeof value === "string") return value;
      if (!Array.isArray(value)) return "";
      let out = "";
      for (const block of value) {
        if (block && block.type === "text" && typeof block.text === "string") {
          out += (out === "" ? "" : "\n") + block.text;
        }
      }
      return out;
    }

    function argsOf(props) {
      const block = props && props.block;
      if (!block) return {};
      if (typeof block.argsRaw === "string") {
        try {
          return JSON.parse(block.argsRaw);
        } catch {
          return {};
        }
      }
      return {};
    }

    function output(text) {
      const lines = text.split("\n");
      const shown = lines.slice(0, 24);
      return h(
        "pre",
        {
          style: {
            margin: "6px 0 0",
            padding: "7px 9px",
            borderRadius: 9,
            background: T.layer1,
            border: `1px solid ${T.border1}`,
            font: "400 11.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 220,
            overflow: "auto",
          },
        },
        shown.join("\n") + (lines.length > shown.length ? "\n…" : ""),
      );
    }

    function header(action, extra) {
      return h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
          },
        },
        h("span", { style: { font: "600 12px/1.2 inherit" } }, "kanban"),
        chip(action ? String(action) : "ukb", { strong: true }),
        ...extra,
      );
    }

    function UkbView(props) {
      try {
        const args = argsOf(props);
        const action = typeof args.action === "string" ? args.action : "ukb";
        const extra = [];
        if (args.id !== undefined)
          extra.push(chip(`#${args.id}`, { mono: true }));
        if (Array.isArray(args.ids) && args.ids.length > 0)
          extra.push(
            chip(args.ids.map((id) => `#${id}`).join(" "), { mono: true }),
          );
        if (typeof args.column === "string") extra.push(chip(args.column));
        if (typeof args.project === "string") extra.push(chip(args.project));

        if (props.phase !== "result") {
          return h(
            "div",
            { style: { padding: "4px 2px" } },
            header(action, extra),
          );
        }

        const text = textOf(props.block && props.block.content);
        let parsed = null;
        if (text.trim().startsWith("{")) {
          try {
            parsed = boardOf(JSON.parse(text));
          } catch {
            parsed = null;
          }
        }

        if (props.block && props.block.isError) {
          return h(
            "div",
            { style: { padding: "4px 2px" } },
            header(action, [...extra, chip("failed", { color: T.danger })]),
            output(text),
          );
        }

        return h(
          "div",
          { style: { padding: "4px 2px", minWidth: 0 } },
          header(action, extra),
          parsed
            ? boardView(parsed, { compact: true, limit: 6 })
            : output(text),
        );
      } catch (error) {
        return h(
          "div",
          {
            style: {
              padding: "4px 2px",
              font: "400 12px/1.4 inherit",
              color: T.text2,
            },
          },
          `ukb result could not be rendered: ${String(error && error.message ? error.message : error)}`,
        );
      }
    }

    return {
      inject: ["slots", "sidebarRight", "sidebarRightTabs"],
      /**
       * Test seam. The Client loader reads only `inject` and `apply`; the unit
       * test reaches the pure workspace → project mapping through the factory
       * because a browser bundle cannot import its Node-testable siblings.
       */
      internals: { projectFromWorkspace, startFullBoard },
      apply(ctx) {
        ctxRef.current = ctx;
        ctx.effect(() =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            title: () => "Kanban",
            guide: [
              {
                id: "ukb-board",
                order: 60,
                title: () => "Kanban board",
                description: () => "Live board columns, filters and counts",
                icon: KanbanGlyph,
              },
            ],
          }),
        );
        ctx.effect(() =>
          ctx.slots.inject("sidebar.right.pane.tab", () =>
            ctx.slots.register(
              { name: "sidebar.right.pane.tab", key: TAB_ID },
              BoardPanel,
            ),
          ),
        );
        ctx.effect(() =>
          ctx.slots.inject("conversation.composer.dock", () =>
            ctx.slots.register(
              { name: "conversation.composer.dock", id: "ukb-chip", order: 20 },
              BoardChip,
            ),
          ),
        );
        ctx.effect(() =>
          ctx.slots.inject("tool.call.toolview", () =>
            ctx.slots.register(
              { name: "tool.call.toolview", key: "ukb" },
              UkbView,
            ),
          ),
        );
      },
    };
  },
});
