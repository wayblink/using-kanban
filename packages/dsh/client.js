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
      text2: "var(--dsw-alias-label-secondary, color-mix(in srgb, currentColor 70%, transparent))",
      text3: "var(--dsw-alias-label-tertiary, color-mix(in srgb, currentColor 52%, transparent))",
      caption: "var(--dsw-alias-label-caption, color-mix(in srgb, currentColor 45%, transparent))",
      base: "var(--dsw-alias-bg-base, transparent)",
      layer1: "var(--dsw-alias-bg-layer-1, color-mix(in srgb, currentColor 4%, transparent))",
      layer2: "var(--dsw-alias-bg-layer-2, color-mix(in srgb, currentColor 7%, transparent))",
      card: "var(--dsw-alias-card-fill, color-mix(in srgb, currentColor 3%, transparent))",
      border1: "var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 10%, transparent))",
      border2: "var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent))",
      border3: "var(--dsw-alias-border-l3, color-mix(in srgb, currentColor 26%, transparent))",
      hover: "var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 7%, transparent))",
      accent: "var(--dsw-alias-brand-primary, currentColor)",
      business: "var(--dsw-alias-state-business-primary, color-mix(in srgb, currentColor 72%, transparent))",
      success: "var(--dsw-alias-state-success-primary, color-mix(in srgb, currentColor 62%, transparent))",
      warn: "var(--dsw-alias-state-warn-primary, color-mix(in srgb, currentColor 55%, transparent))",
      danger: "var(--dsw-alias-state-error-primary, color-mix(in srgb, currentColor 80%, transparent))",
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
    const STATE_LIMIT = { todo: 200, doing: 200, review: 200, done: 25, someday: 60 };
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
            font: mono ? "500 10.5px/1 ui-monospace, SFMono-Regular, Menlo, monospace" : "500 11px/1 inherit",
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
            transition: "background 120ms ease, border-color 120ms ease, color 120ms ease",
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
          onChange: (event) => onChange(event.target.value === "" ? null : event.target.value),
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
        ...projects.map((project) => h("option", { key: project, value: project }, project)),
      );
    }

    function searchInput(value, onChange) {
      return h(
        "div",
        { style: { display: "flex", alignItems: "center", flex: "1 1 160px", minWidth: 140 } },
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
            { width: 13, height: 13, viewBox: "0 0 24 24", "aria-hidden": true, style: { flex: "0 0 auto", opacity: 0.6 } },
            h("circle", { cx: 11, cy: 11, r: 7, fill: "none", stroke: "currentColor", strokeWidth: 2 }),
            h("path", { d: "M16.5 16.5 21 21", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" }),
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

    function priorityDot(card) {
      const priority = card.priority ?? "normal";
      if (priority === "normal") return null;
      return h("span", {
        title: `${priority} priority`,
        style: {
          width: 6,
          height: 6,
          borderRadius: 999,
          flex: "0 0 auto",
          background: priority === "high" ? T.danger : T.text3,
          opacity: priority === "high" ? 1 : 0.7,
        },
      });
    }

    function avatar(name) {
      if (typeof name !== "string" || name === "") return null;
      return h(
        "span",
        {
          title: `@${name}`,
          style: {
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 16,
            height: 16,
            borderRadius: 999,
            background: T.layer2,
            border: `1px solid ${T.border1}`,
            color: T.text2,
            font: "600 9px/1 inherit",
            textTransform: "uppercase",
            flex: "0 0 auto",
          },
        },
        name.slice(0, 1),
      );
    }

    function detailBlock(detail, accent) {
      if (detail === undefined || detail === null) {
        return h("div", { style: { font: "400 11.5px/1.4 inherit", color: T.text3 } }, "Loading card…");
      }
      if (detail.status === "error") {
        return h("div", { style: { font: "400 11.5px/1.4 inherit", color: T.danger } }, detail.error);
      }
      const fields = detail.fields ?? {};
      const chips = [];
      if (fields["parent"]) chips.push(chip(fields["parent"], { mono: true }));
      if (fields["blocked by"] && fields["blocked by"] !== "—") chips.push(chip(`blocked by ${fields["blocked by"]}`, { color: T.warn }));
      if (fields["created by"]) chips.push(chip(`by ${fields["created by"].split(" · ")[0]}`));
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 6 } },
        chips.length > 0 ? h("div", { style: { display: "flex", gap: 4, flexWrap: "wrap" } }, ...chips) : null,
        detail.body
          ? h(
              "div",
              {
                style: {
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  font: "400 11.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace",
                  color: T.text2,
                  background: `color-mix(in srgb, ${accent} 5%, ${T.base})`,
                  border: `1px solid ${T.border1}`,
                  borderRadius: 8,
                  padding: "7px 9px",
                  maxHeight: 420,
                  overflow: "auto",
                },
              },
              detail.body,
            )
          : h("div", { style: { font: "400 11.5px/1.4 inherit", color: T.text3 } }, "No body."),
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

    function cardRow(card, options) {
      const compact = options?.compact === true;
      const expanded = options?.expanded === true;
      const accent = options?.accent ?? T.text3;
      const noteCount = Array.isArray(card.notes) ? card.notes.length : 0;
      const blocked = Array.isArray(card.blockedBy) ? card.blockedBy.length : 0;
      const meta = [];
      if (card.project) meta.push(chip(card.project, { mono: true }));
      if (blocked > 0) meta.push(chip(`⛔ ${blocked}`, { color: T.warn }));
      if (noteCount > 0) meta.push(chip(`✎ ${noteCount}`));

      return h(
        "div",
        {
          key: String(card.id),
          role: "button",
          tabIndex: 0,
          onClick: () => options?.onToggleCard?.(card.id),
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              options?.onToggleCard?.(card.id);
            }
          },
          style: {
            display: "flex",
            flexDirection: "column",
            /* An expanded card takes the whole section row, so its body reads at
               full panel width instead of in one grid cell. */
            gridColumn: expanded ? "1 / -1" : "auto",
            gap: compact && !expanded ? 2 : 4,
            padding: compact && !expanded ? "5px 7px" : "7px 9px",
            borderRadius: 9,
            background: expanded ? `color-mix(in srgb, ${accent} 7%, ${T.card})` : T.card,
            border: `1px solid ${expanded ? accent : T.border1}`,
            transition: "border-color 120ms ease, background 120ms ease, transform 120ms ease",
            cursor: "pointer",
          },
          onMouseEnter: (event) => {
            event.currentTarget.style.borderColor = accent;
            event.currentTarget.style.transform = "translateY(-1px)";
          },
          onMouseLeave: (event) => {
            event.currentTarget.style.borderColor = expanded ? accent : T.border1;
            event.currentTarget.style.transform = "none";
          },
          title: typeof card.title === "string" ? card.title : "",
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 5, minWidth: 0 } },
          h("span", { style: { font: "500 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace", color: T.text3 } }, `#${card.id}`),
          priorityDot(card),
          h("span", { style: { flex: "1 1 auto" } }),
          !compact && card.state === "review" && card.reviewer
            ? h("span", { style: { font: "500 9.5px/1 inherit", color: T.warn } }, "→ " + card.reviewer)
            : null,
          !compact ? avatar(card.assignee) : null,
        ),
        h(
          "div",
          {
            style: {
              font: `${compact && !expanded ? 400 : 500} 12px/1.35 inherit`,
              color: T.text,
              display: "-webkit-box",
              WebkitLineClamp: expanded ? 6 : compact ? 1 : 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              overflowWrap: "anywhere",
            },
          },
          typeof card.title === "string" ? card.title : "",
        ),
        compact && !expanded || meta.length === 0
          ? null
          : h("div", { style: { display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" } }, ...meta),
        expanded ? detailBlock(options?.detail, accent) : null,
      );
    }

    function section(state, cards, options) {
      const limit = options?.limit ?? 200;
      const shown = cards.slice(0, limit);
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
            title: collapsed ? `Show ${STATE_LABEL[state]}` : `Collapse ${STATE_LABEL[state]}`,
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
          h("span", { style: { width: 8, height: 8, borderRadius: 999, background: color, flex: "0 0 auto" } }),
          h(
            "span",
            { style: { font: "700 11px/1.2 inherit", letterSpacing: "0.06em", textTransform: "uppercase", color } },
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
            String(cards.length),
          ),
          h("span", { style: { flex: "1 1 auto" } }),
          h("span", { style: { font: "600 10px/1 inherit", color: T.text3 } }, collapsed ? "▸" : "▾"),
        ),
        collapsed
          ? null
          : h(
              "div",
              {
                style: {
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
                  gap: compact ? 5 : 7,
                  padding: 8,
                  alignContent: "start",
                },
              },
              shown.length === 0
                ? h(
                    "div",
                    {
                      style: {
                        gridColumn: "1 / -1",
                        padding: "9px 8px",
                        borderRadius: 9,
                        border: `1px dashed ${T.border1}`,
                        color: T.caption,
                        font: "400 11.5px/1.3 inherit",
                        textAlign: "center",
                      },
                    },
                    "Empty",
                  )
                : null,
              ...shown.map((card) =>
                cardRow(card, {
                  ...options,
                  accent: color,
                  expanded: options?.expandedId === card.id,
                  detail: options?.detail,
                  onToggleCard: options?.onToggleCard,
                }),
              ),
              cards.length > shown.length
                ? h(
                    "div",
                    { style: { gridColumn: "1 / -1", font: "400 11px/1.4 inherit", color: T.text3, paddingLeft: 4 } },
                    `+${cards.length - shown.length} more`,
                  )
                : null,
            ),
      );
    }

    function boardView(board, options) {
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 12 } },
        ...STATES.map((state) =>
          section(state, board[state], {
            ...options,
            limit: options?.limit ?? STATE_LIMIT[state] ?? 200,
            collapsed: options?.collapsedStates?.has(state) === true,
          }),
        ),
      );
    }

    /** A board object is `{ someday, todo, doing, review, done }` of card arrays. */
    function boardOf(value) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
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
        h("rect", { x: 3, y: 4, width: 5, height: 16, rx: 1.4, fill: "none", stroke: "currentColor", strokeWidth: 1.7 }),
        h("rect", { x: 9.5, y: 4, width: 5, height: 10, rx: 1.4, fill: "none", stroke: "currentColor", strokeWidth: 1.7 }),
        h("rect", { x: 16, y: 4, width: 5, height: 13, rx: 1.4, fill: "none", stroke: "currentColor", strokeWidth: 1.7 }),
      );
    }

    /* ---------------------------------- data ---------------------------------- */

    /**
     * Candidate URLs for the host route. The app may be served from a sub-path,
     * from `dsh-app://app/`, or with an SPA route already in `document.baseURI`;
     * the first candidate that answers JSON wins.
     */
    function boardUrls(project) {
      const bases = [];
      try { bases.push(document.baseURI); } catch { /* no document base */ }
      try { if (location.origin && location.origin !== "null") bases.push(`${location.origin}/`); } catch { /* no origin */ }
      try { bases.push(location.href); } catch { /* no location */ }
      const paths = [];
      for (const base of bases) {
        try {
          paths.push(new URL("api/ukb/board", base).toString());
        } catch {
          // A base that cannot be parsed simply contributes no candidate.
        }
      }
      try {
        paths.push(new URL("/api/ukb/board", location.origin).toString());
      } catch {
        // `file:` and similar origins have no usable origin.
      }
      return [...new Set(paths)].map((href) => {
        const url = new URL(href);
        if (project) url.searchParams.set("project", project);
        return url.toString();
      });
    }

    /** One JSON answer from the first candidate that speaks JSON. */
    async function readBoardJson(project) {
      const tried = [];
      for (const url of boardUrls(project)) {
        tried.push(url);
        try {
          const response = await fetch(url, { headers: { accept: "application/json" } });
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
      return { ok: false, error: `no candidate answered JSON; tried ${tried.join(", ")}`, tried };
    }

    /** Candidate URLs for the card-detail route, same resolution as the board. */
    function cardUrls(id) {
      const bases = [];
      try { bases.push(document.baseURI); } catch { /* no document base */ }
      try { if (location.origin && location.origin !== "null") bases.push(`${location.origin}/`); } catch { /* no origin */ }
      try { bases.push(location.href); } catch { /* no location */ }
      const paths = [];
      for (const base of bases) {
        try {
          paths.push(new URL("api/ukb/card", base).toString());
        } catch {
          // Unusable base.
        }
      }
      try {
        paths.push(new URL("/api/ukb/card", location.origin).toString());
      } catch {
        // No usable origin.
      }
      return [...new Set(paths)].map((href) => {
        const url = new URL(href);
        url.searchParams.set("id", String(id));
        return url.toString();
      });
    }

    /** `ukb show <id>` as `{ status, fields, body, history }`, or an error. */
    async function readCardJson(id) {
      const tried = [];
      for (const url of cardUrls(id)) {
        tried.push(url);
        try {
          const response = await fetch(url, { headers: { accept: "application/json" } });
          const text = await response.text();
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            continue;
          }
          if (body && typeof body === "object" && body.error) return { ok: false, error: String(body.error) };
          if (!response.ok || typeof body.text !== "string") continue;
          return { ok: true, body };
        } catch {
          // Try the next candidate.
        }
      }
      return { ok: false, error: `no candidate answered; tried ${tried.join(", ")}` };
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
      for (let index = head === null ? 0 : 1; index < lines.length; index += 1) {
        const line = lines[index];
        const field = /^([a-z][a-z ]*):\s*(.*)$/u.exec(line);
        if (field !== null) {
          sectionName = field[1];
          fields[sectionName] = field[2];
          continue;
        }
        if (sectionName === "body") body.push(line.replace(/^ {2}/u, ""));
        else if (sectionName === "history") history.push(line.replace(/^ {2}/u, ""));
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
      const [state, setState] = useState({ status: "loading", board: null, identity: null, error: null, at: null });
      const [nonce, setNonce] = useState(0);
      const refresh = useCallback(() => setNonce((value) => value + 1), []);
      useEffect(() => {
        let alive = true;
        const read = async () => {
          const result = await readBoardJson(null);
          if (!alive) return;
          if (!result.ok) {
            setState({ status: "error", board: null, identity: null, error: result.error, at: null });
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
      const useSessions = typeof props.useSessions === "function" ? props.useSessions : () => undefined;
      return useSessions((state) => (props.sessionId ? state.byId[props.sessionId]?.cwd : undefined));
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
      if (typeof cwd !== "string" || cwd === "" || !Array.isArray(projects)) return null;
      /** @type {Map<string, string>} */
      const known = new Map();
      for (const name of projects) {
        if (typeof name === "string" && name !== "") known.set(name.toLowerCase(), name);
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
          if (typeof card.project === "string" && card.project !== "") names.add(card.project);
        }
      }
      return [...names].sort((a, b) => a.localeCompare(b));
    }

    function matches(card, filters, identity) {
      if (filters.project !== null && card.project !== filters.project) return false;
      const owner = identity?.owner ?? null;
      const agent = identity?.agent ?? null;
      if (filters.scope === "mine" && (owner === null || card.assignee !== owner)) return false;
      if (filters.scope === "agent" && (agent === null || card.assignee !== agent)) return false;
      if (filters.scope === "review") {
        if (card.state !== "review") return false;
        if (owner !== null && card.reviewer !== null && card.reviewer !== undefined && card.reviewer !== owner) return false;
      }
      const query = filters.query.trim().toLowerCase();
      if (query !== "") {
        const haystack = `${card.id} ${card.title ?? ""} ${card.project ?? ""} ${card.assignee ?? ""}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    }

    function applyFilters(board, filters, identity) {
      const out = {};
      for (const state of STATES) out[state] = board[state].filter((card) => matches(card, filters, identity));
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
        globalThis.localStorage?.setItem(DENSITY_KEY, compact ? "compact" : "comfortable");
      } catch {
        // Storage may be unavailable; density simply does not persist.
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
              [id]: result.ok ? parseShow(result.body.text) : { status: "error", error: result.error },
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

      const projects = useMemo(() => (board === null ? [] : projectsOf(board)), [board]);
      const workspaceProject = useMemo(() => projectFromWorkspace(cwd, projects), [cwd, projects]);
      const project = projectChoice === undefined ? workspaceProject : projectChoice;
      const filters = useMemo(() => ({ query, project, scope }), [query, project, scope]);
      const filtered = useMemo(() => (board === null ? null : applyFilters(board, filters, identity)), [board, filters, identity]);
      const total = filtered === null ? 0 : countOf(filtered);
      const grandTotal = board === null ? 0 : countOf(board);
      /** The visible board is narrowed — by a choice or by the workspace default. */
      const scoped = query !== "" || project !== null || scope !== "all";
      /** The reader has overridden a default, so Clear has something to restore. */
      const adjusted = query !== "" || projectChoice !== undefined || scope !== "all";

      const clearFilters = useCallback(() => {
        setQuery("");
        setProjectChoice(undefined);
        setScope("all");
      }, []);

      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, color: T.text } },
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
          h("span", { style: { font: "650 14px/1.2 inherit", letterSpacing: "-0.01em" } }, "Kanban"),
          h("span", { style: { font: "500 11px/1 inherit", color: T.text3 } }, scoped ? `${total} of ${grandTotal}` : `${grandTotal} cards`),
          at !== null ? h("span", { style: { font: "400 10.5px/1 inherit", color: T.caption } }, timeAgo(at)) : null,
          h("span", { style: { flex: "1 1 auto" } }),
          iconButton(compact ? "Comfortable" : "Compact", () => {
            const next = !compact;
            setCompact(next);
            writeDensity(next);
          }, compact),
          iconButton("Refresh", refresh),
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
          projectSelect(projects, project, setProjectChoice, projectChoice === undefined && workspaceProject !== null),
          segmented(SCOPES, scope, setScope),
          adjusted ? iconButton("Clear", clearFilters) : null,
        ),
        status === "loading"
          ? h("div", { style: { padding: "18px 14px", font: "400 12px/1.5 inherit", color: T.text3 } }, "Reading the board…")
          : null,
        status === "error"
          ? h(
              "div",
              { style: { padding: "16px 14px", font: "400 12px/1.5 inherit", color: T.text2 } },
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
                    { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "28px 0", color: T.text3 } },
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
                      ? iconButton("Show all projects", () => setProjectChoice(null))
                      : iconButton("Clear filters", clearFilters),
                  )
                : boardView(filtered, {
                    compact,
                    expandedId,
                    detail: expandedId === null ? undefined : details[expandedId],
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

    /* ---------------------------------- chip ---------------------------------- */

    function BoardChip() {
      const { status, board } = useBoard();
      const open = useCallback(() => {
        try {
          ctxRef.current.sidebarRight.openTab(TAB_KIND);
        } catch (error) {
          console.warn("[ukb] could not open the board panel", error);
        }
      }, []);
      if (status !== "ready") return null;
      const counts = ["doing", "todo", "review"].map((state) => [state, board[state].length]);
      if (counts.every(([, count]) => count === 0)) return null;
      return h(
        "button",
        {
          type: "button",
          onClick: open,
          title: "Open the kanban board",
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
        ...counts.map(([state, count]) =>
          h(
            "span",
            { key: state, style: { display: "inline-flex", alignItems: "center", gap: 4, color: count === 0 ? T.caption : T.text } },
            h("span", { style: { width: 5, height: 5, borderRadius: 999, background: STATE_COLOR[state], opacity: count === 0 ? 0.4 : 1 } }),
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
        { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
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
        if (args.id !== undefined) extra.push(chip(`#${args.id}`, { mono: true }));
        if (Array.isArray(args.ids) && args.ids.length > 0) extra.push(chip(args.ids.map((id) => `#${id}`).join(" "), { mono: true }));
        if (typeof args.column === "string") extra.push(chip(args.column));
        if (typeof args.project === "string") extra.push(chip(args.project));

        if (props.phase !== "result") {
          return h("div", { style: { padding: "4px 2px" } }, header(action, extra));
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
          return h("div", { style: { padding: "4px 2px" } }, header(action, [...extra, chip("failed", { color: T.danger })]), output(text));
        }

        return h(
          "div",
          { style: { padding: "4px 2px", minWidth: 0 } },
          header(action, extra),
          parsed ? boardView(parsed, { compact: true, limit: 6 }) : output(text),
        );
      } catch (error) {
        return h(
          "div",
          { style: { padding: "4px 2px", font: "400 12px/1.4 inherit", color: T.text2 } },
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
      internals: { projectFromWorkspace },
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
            ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, BoardPanel),
          ),
        );
        ctx.effect(() =>
          ctx.slots.inject("conversation.composer.dock", () =>
            ctx.slots.register({ name: "conversation.composer.dock", id: "ukb-chip", order: 20 }, BoardChip),
          ),
        );
        ctx.effect(() =>
          ctx.slots.inject("tool.call.toolview", () =>
            ctx.slots.register({ name: "tool.call.toolview", key: "ukb" }, UkbView),
          ),
        );
      },
    };
  },
});
