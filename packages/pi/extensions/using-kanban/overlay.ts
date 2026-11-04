/**
 * overlay.ts — lifecycle controller for the board widget above the editor.
 *
 * Pi's widget contract is register-once, then `requestRender()` on change. This
 * class owns that: it holds the raw and scoped board snapshots, registers the
 * widget when visibility is requested and the view's displayed states have any
 * cards, repaints on refresh, and unregisters on hide or when nothing visible
 * remains. All layout lives in the pure `overlay-render.ts`.
 *
 * Refreshing shells out to `ukb board --json` rather than reading the board
 * in-process: the CLI is the one front door that owns storage resolution, and
 * loading the board's native sqlite dependency into the Pi process is not worth
 * the convenience. Refresh is trigger-driven, never a poll — session start, the
 * end of a `ukb` tool call, the start of each turn, and any `/ukb` slash command
 * that changed the board.
 *
 * The row budget lives on the view, not on the constructor, because
 * `/ukb gui more` raises it for the current session. A panel that hides
 * rows with no way to reveal them is a dead end, and the reader should not have
 * to edit a config file and reload just to see the rest of their own board.
 */

import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF } from "./overlay-config.js";
import {
  type BoardSnapshot,
  type OverlayView,
  OVERLAY_WIDGET_KEY,
  cardIndex,
  countCards,
  parseBoardJson,
  renderOverlay,
  renderSplitColumns,
  rightPaneView,
  scopeBoard,
  visibleCardCount,
} from "./overlay-render.js";

/** Runs `ukb board --json` and returns its stdout, or why it did not. */
export type BoardFetcher = () => Promise<BoardRead>;

/**
 * What a board read produced.
 *
 * The `error` is not for the caller to handle — it exists so a hidden widget
 * can say why it is hidden. A widget that fails silently is indistinguishable
 * from a widget that was never installed, which is precisely the bug that cost
 * an evening: `catch {}` keeps the session alive and leaves the user with
 * nothing to report.
 */
export interface BoardRead {
  readonly stdout: string | null;
  readonly error: string | null;
}

export interface BoardOverlayOptions {
  /** Resolved collapse key spec, or the `off` sentinel. */
  readonly collapseKey: string;
  /**
   * The view, including its row budget. The budget travels with the view so
   * `/ukb gui more` can raise it without rebuilding the widget.
   */
  readonly view: OverlayView;
  readonly initiallyVisible: boolean;
}

export interface BoardOverlayStatus {
  readonly uiBound: boolean;
  readonly registered: boolean;
  readonly collapsed: boolean;
  readonly visible: boolean;
  readonly counts: {
    readonly someday: number;
    readonly todo: number;
    readonly doing: number;
    readonly review: number;
    readonly done: number;
  } | null;
  readonly error: string | null;
  readonly scope: OverlayView["scope"];
  readonly project: string | null;
  readonly groupBy: OverlayView["groupBy"];
  readonly scopeLabel: string;
  /** Active content-row budget, including the heading. */
  readonly maxLines: number;
  /** Whether the second pane is on. */
  readonly split: boolean;
  /** Cards the second pane is showing, or null when it is off or empty. */
  readonly rightCount: number | null;
}

export class BoardOverlay {
  private uiCtx: ExtensionUIContext | undefined;
  private widgetRegistered = false;
  private tui: TUI | undefined;
  private rawSnapshot: BoardSnapshot | undefined;
  private snapshot: BoardSnapshot | undefined;
  private scopeLabel = "";
  private view: OverlayView;
  private visible: boolean;
  private collapsed = false;
  /** One-shot latch so a repeating failure does not spam notifications. */
  private reported = false;
  private lastError: string | null = null;

  constructor(
    private readonly fetchBoard: BoardFetcher,
    private readonly options: BoardOverlayOptions,
  ) {
    this.view = options.view;
    this.visible = options.initiallyVisible;
  }

  /**
   * Bind (or rebind) the UI context. Identity-compare so a repeated
   * `session_start` is idempotent while `/reload` — a new ctx — invalidates the
   * cached widget handle so `update()` re-registers.
   */
  setUICtx(ctx: ExtensionUIContext): void {
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
    }
  }

  /** Re-read the board and repaint. A failed read hides the widget. */
  async refresh(): Promise<void> {
    const read = await this.fetchBoard();
    const parsed = read.stdout === null ? null : parseBoardJson(read.stdout);
    this.rawSnapshot = parsed ?? undefined;
    this.applyView();
    this.lastError =
      read.error ??
      (read.stdout !== null && parsed === null
        ? "ukb board --json returned malformed JSON"
        : null);
    this.update();
    this.reportUnreadable(this.lastError);
  }

  status(): BoardOverlayStatus {
    const rightPane = this.rightPane();
    return {
      uiBound: this.uiCtx !== undefined,
      registered: this.widgetRegistered,
      collapsed: this.collapsed,
      visible: this.visible,
      counts: this.snapshot === undefined ? null : countCards(this.snapshot),
      error: this.lastError,
      scope: this.view.scope,
      project: this.view.project,
      groupBy: this.view.groupBy,
      scopeLabel: this.scopeLabel,
      maxLines: this.view.maxLines,
      split: this.view.split,
      rightCount:
        rightPane === undefined
          ? null
          : visibleCardCount(rightPane.snapshot, rightPaneView(this.view).states),
    };
  }

  setView(view: OverlayView): void {
    this.view = view;
    this.applyView();
    this.update();
  }

  private applyView(): void {
    if (this.rawSnapshot === undefined) {
      this.snapshot = undefined;
      this.scopeLabel = "";
      return;
    }
    const scoped = scopeBoard(this.rawSnapshot, this.view);
    this.snapshot = scoped.snapshot;
    this.scopeLabel = scoped.label;
  }

  /**
   * Say once why the panel is not on screen. Reset on the next good read so a
   * transient failure does not mute the diagnostic for the whole session.
   */
  private reportUnreadable(error: string | null): void {
    if (error === null) {
      this.reported = false;
      return;
    }
    if (this.reported || this.snapshot !== undefined) return;
    this.reported = true;
    try {
      this.uiCtx?.notify(`ukb gui: ${error}`, "warning");
    } catch {
      // A notification is best-effort. The hidden panel is the fallback, and
      // hiding it silently is the thing being fixed.
    }
  }

  show(): void {
    this.visible = true;
    this.update();
  }

  hide(): void {
    this.visible = false;
    this.unregister();
  }

  collapse(): void {
    this.setCollapsed(true);
  }

  expand(): void {
    this.setCollapsed(false);
  }

  toggleCollapse(): void {
    this.setCollapsed(!this.collapsed);
  }

  private setCollapsed(collapsed: boolean): void {
    if (this.collapsed === collapsed) return;
    this.collapsed = collapsed;
    // Forced full redraw: the collapsed↔expanded step changes the widget height.
    this.tui?.requestRender(true);
  }

  isRegistered(): boolean {
    return this.widgetRegistered;
  }

  private update(): void {
    const ctx = this.uiCtx;
    if (!ctx) return;

    const snapshot = this.snapshot;
    const hasVisibleCards =
      snapshot !== undefined &&
      (visibleCardCount(snapshot, this.view.states) > 0 ||
        this.rightPane() !== undefined);

    if (!this.visible || !hasVisibleCards) {
      this.unregister();
      return;
    }

    if (!this.widgetRegistered) {
      ctx.setWidget(
        OVERLAY_WIDGET_KEY,
        (tui, factoryTheme) => {
          this.tui = tui;
          return {
            render: (width: number) =>
              this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
            // Nothing is cached; Pi invalidates on theme changes and the next
            // render reads `uiCtx.theme`.
            invalidate: () => {},
          };
        },
        { placement: "aboveEditor" },
      );
      this.widgetRegistered = true;
      return;
    }

    this.tui?.requestRender();
  }

  private unregister(): void {
    if (this.widgetRegistered && this.uiCtx) {
      this.uiCtx.setWidget(OVERLAY_WIDGET_KEY, undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
  }

  /**
   * The second pane's snapshot, or undefined when the pane is off, empty, or
   * the terminal is collapsed.
   *
   * Scoped from the *raw* board, not from the left pane's slice: a left pane
   * fixed to this repository must not stop the right pane from showing the
   * shelf elsewhere when it was asked for `scope=all`.
   */
  private rightPane(): { snapshot: BoardSnapshot; label: string } | undefined {
    if (!this.view.split || this.collapsed) return undefined;
    if (this.rawSnapshot === undefined) return undefined;
    const view = rightPaneView(this.view);
    const scoped = scopeBoard(this.rawSnapshot, view);
    if (visibleCardCount(scoped.snapshot, view.states) === 0) return undefined;
    return scoped;
  }

  private renderWidget(theme: Theme, width: number): string[] {
    const snapshot = this.snapshot;
    if (snapshot === undefined) return [];
    try {
      const left =
        visibleCardCount(snapshot, this.view.states) === 0
          ? []
          : renderOverlay(snapshot, this.renderOptions(theme, width));
      const rightPane = this.rightPane();
      if (rightPane === undefined) return left;
      const rightView = rightPaneView(this.view);
      const right = renderOverlay(rightPane.snapshot, {
        ...this.renderOptions(theme, width),
        scopeLabel: rightPane.label,
        groupBy: rightView.groupBy ?? this.view.groupBy,
        states: rightView.states,
      });
      // Nothing on the left: show the shelf at full width rather than half of
      // a panel whose other half is blank.
      if (left.length === 0) return right;
      return renderSplitColumns(left, right, {
        width,
        gap: theme.fg("dim", " │ "),
        truncate: (line, maxWidth) => truncateToWidth(line, maxWidth, "…"),
        visibleWidth,
      });
    } catch (error) {
      this.reported = true;
      try {
        this.uiCtx?.notify(
          `ukb gui: render failed — ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      } catch {
        // Nothing further to do.
      }
      return [];
    }
  }

  private renderOptions(
    theme: Theme,
    width: number,
  ): Parameters<typeof renderOverlay>[1] {
    return {
        theme,
        truncate: (line, maxWidth) => truncateToWidth(line, maxWidth, "…"),
        visibleWidth,
        width,
        budget: this.view.maxLines,
        collapsed: this.collapsed,
        collapseKey: this.options.collapseKey,
        scopeLabel: this.scopeLabel,
        groupBy: this.view.groupBy,
        // The scope is part of the card, not of the view: show it in every
        // scope, including `mine` and a single project, so `web/auth` is where
        // a row lives rather than something the heading implies. Grouping by
        // project already prints it, so that case opts out rather than
        // duplicating the label.
        showProject: this.view.groupBy !== "project",
        states: this.view.states,
        // Progress is global: count children the scope filtered out too.
        index:
          this.rawSnapshot === undefined
            ? undefined
            : cardIndex(this.rawSnapshot),
    };
  }

  dispose(): void {
    if (this.uiCtx) this.uiCtx.setWidget(OVERLAY_WIDGET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
    this.visible = false;
    this.collapsed = false;
    this.rawSnapshot = undefined;
    this.snapshot = undefined;
    this.scopeLabel = "";
    this.lastError = null;
    this.reported = false;
  }
}

export { COLLAPSE_KEY_OFF };
