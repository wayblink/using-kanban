#!/usr/bin/env node
/**
 * Zero-dependency browser check: drives headless Chrome over the DevTools
 * Protocol using Node's built-in WebSocket. No Playwright, no Puppeteer.
 *
 *   node scripts/browser-check.mjs [--url <url>] [--out <file>] [--width 1600]
 *
 * It screenshots the page, asserts the layout, exercises the card dialog and modal,
 * and prints any console errors.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "@wayblink/using-kanban-server";

/**
 * The Chrome binary, resolved the same way on every platform: `CHROME_PATH`
 * (or `CHROME_BIN`) wins, then the macOS app, then whatever `google-chrome` /
 * `chromium` is on PATH — which is what the Linux CI runner ships. A hardcoded
 * macOS path is why this check could only ever have run on one laptop.
 */
function resolveChrome() {
  const explicit = process.env.CHROME_PATH ?? process.env.CHROME_BIN;
  if (explicit) return explicit;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(mac)) return mac;
  for (const name of [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ]) {
    const found = spawnSync("which", [name], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error(
    "no Chrome found — install one or set CHROME_PATH (looked for the macOS app, google-chrome, chromium)",
  );
}

const CHROME = resolveChrome();
const DEBUG_PORT = 9222;

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}

// Reusing whatever happens to listen on the default port makes the run
// non-deterministic (and token-less). Only reuse a server when --url is given.
const explicitUrl = args.includes("--url");
let url = flag("url", "http://127.0.0.1:48999/");
const out = flag("out", "/tmp/ukb-browser-check.png");
const width = Number(flag("width", "1600"));
const height = Number(flag("height", "1000"));

/* ------------------------------- cdp client ------------------------------ */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.consoleErrors = [];
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params ?? {});
      }
    };
  }

  static async connect(webSocketDebuggerUrl) {
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("websocket failed to open"));
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000);
    });
  }

  on(method, listener) {
    const existing = this.listeners.get(method) ?? [];
    existing.push(listener);
    this.listeners.set(method, existing);
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const description = details.exception?.description ?? details.text;
      throw new Error(`page js failed: ${description}`);
    }
    return result.result.value;
  }

  async clickCenter(selector) {
    const box = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) {
        // surface why: page errors, or simply nothing rendered
        return { missing: true, text: document.body.innerText.slice(0, 300) };
      }
      // Bring it into view first, the way a real click would. A page whose
      // container scrolls (the card dialog, a column) puts targets below the fold,
      // and a synthetic click at those coordinates lands on nothing — or on the
      // backdrop, which closes the very panel the next step reads.
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (box?.missing) {
      throw new Error(
        `no element for ${selector} — page says: ${JSON.stringify(box.text)}`,
      );
    }
    if (!box) throw new Error(`no element for ${selector}`);
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
  }

  async clickPoint(x, y) {
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  close() {
    this.ws.close();
  }
}

/* --------------------------------- main --------------------------------- */

async function main() {
  const profileDir = mkdtempSync(join(tmpdir(), "ukb-chrome-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    "about:blank",
  ]);
  chrome.stderr.on("data", () => undefined);

  const cleanup = () => {
    chrome.kill();
    try {
      rmSync(profileDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    } catch {
      // chrome may still be flushing its profile
    }
  };
  process.on("exit", cleanup);

  // If nothing is serving the UI, start a throwaway board so the check is
  // self-contained: `pnpm browser-check` works with zero setup.
  let server = null;
  if (!explicitUrl) {
    const dir = mkdtempSync(join(tmpdir(), "ukb-browser-board-"));
    // A document a note can link at, so the in-UI document viewer has something
    // real to read rather than a fixture.
    const docRoot = join(dir, "docs");
    mkdirSync(docRoot, { recursive: true });
    writeFileSync(
      join(docRoot, "rest-api.md"),
      [
        "# REST API design",
        "",
        "The board is **event-sourced**: every change appends an event.",
        "",
        "## Endpoints",
        "",
        "- `GET /api/board`",
        "- `POST /api/cards`",
        "",
        "| Method | Path |",
        "| --- | --- |",
        "| GET | /api/board |",
      ].join("\n"),
      "utf8",
    );
    server = await startServer({
      dir,
      uiDir: new URL("../src", import.meta.url).pathname,
      port: Number(new URL(url).port) || 48080,
      token: "browser-check",
      docRoots: [docRoot],
      // The browser has no identity picker any more — it acts as the server's
      // default actor, so the seeded cards must be created by that same name.
      actor: { name: "jyxc", type: "human" },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const created = [];
    for (const card of [
      {
        title: "Design the REST API",
        body: "AC: verified in a browser",
        reviewer: "jyxc",
      },
      {
        title: "Write the MCP tool descriptions",
        body: "AC: verified in a browser",
        reviewer: "jyxc",
      },
      { title: "project: web card", project: "web", reviewer: "jyxc" },
      { title: "project: api card", project: "api", reviewer: "jyxc" },
    ]) {
      const response = await fetch(`${base}/api/cards?token=browser-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Actor-Name": "jyxc" },
        body: JSON.stringify(card),
      });
      created.push(await response.json());
    }
    const [api, mcp] = created;
    // A relation (card 2 waits on card 1) and a note pointing at the document
    // above — the two things the card dialog has to render from either end.
    await fetch(`${base}/api/cards/${mcp.card.id}/relate?token=browser-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Actor-Name": "jyxc" },
      body: JSON.stringify({ other: api.card.id, direction: "upstream" }),
    });
    await fetch(`${base}/api/cards/${api.card.id}/notes?token=browser-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Actor-Name": "jyxc" },
      body: JSON.stringify({
        text: "the REST design doc",
        url: "docs/rest-api.md",
      }),
    });
    // Enough finished cards to exercise the done-column preview, which is what
    // keeps a centralised board (dozens or hundreds of done cards) on one screen.
    for (let index = 0; index < 11; index += 1) {
      const created = await fetch(`${base}/api/cards?token=browser-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Actor-Name": "jyxc" },
        body: JSON.stringify({
          title: `finished card ${index + 1}`,
          project: index % 2 === 0 ? "web" : "api",
        }),
      }).then((response) => response.json());
      await fetch(
        `${base}/api/cards/${created.card.id}/done?token=browser-check`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Actor-Name": "jyxc",
          },
          body: "{}",
        },
      );
    }
    url = `${base}/?token=browser-check`;
  }

  try {
    // wait for the debugging endpoint
    let version = null;
    for (let attempt = 0; attempt < 40 && !version; attempt += 1) {
      try {
        version = await fetch(
          `http://127.0.0.1:${DEBUG_PORT}/json/version`,
        ).then((r) => r.json());
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!version) throw new Error("chrome did not expose a debugging endpoint");

    const targets = await fetch(
      `http://127.0.0.1:${DEBUG_PORT}/json/list`,
    ).then((r) => r.json());
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("no page target");

    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);

    cdp.on("Runtime.consoleAPICalled", (params) => {
      if (params.type === "error") {
        cdp.consoleErrors.push(
          params.args.map((arg) => arg.value ?? arg.description).join(" "),
        );
      }
    });
    cdp.on("Runtime.exceptionThrown", (params) => {
      cdp.consoleErrors.push(params.exceptionDetails.text);
    });

    const loaded = new Promise((resolve) =>
      cdp.on("Page.loadEventFired", resolve),
    );
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url });
    await Promise.race([
      loaded,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("page never loaded")), 15000),
      ),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 400));

    /* ---------------------------- assertions ---------------------------- */

    // start on the board view for the board assertions below
    await cdp.send("Page.navigate", { url: `${url}#/board` });
    await new Promise((resolve) => setTimeout(resolve, 600));

    const report = [];

    const phantom = await cdp.evaluate(`(() => {
      const hidden = [];
      for (const selector of ['#card-dialog', '#modal', '#card-dialog-backdrop', '#modal-backdrop']) {
        const el = document.querySelector(selector);
        hidden.push([selector, getComputedStyle(el).display]);
      }
      return hidden;
    })()`);
    report.push([
      "hidden panels are display:none",
      phantom.every(([, display]) => display === "none"),
      phantom,
    ]);

    const layout = await cdp.evaluate(`(() => {
      const board = document.querySelector('#board');
      const columns = [...document.querySelectorAll('.column')];
      return {
        viewport: window.innerWidth,
        boardWidth: Math.round(board.getBoundingClientRect().width),
        columns: columns.length,
        columnTops: columns.map((c) => Math.round(c.getBoundingClientRect().top)),
        columnWidths: columns.map((c) => Math.round(c.getBoundingClientRect().width)),
        cards: document.querySelectorAll('.card').length,
      };
    })()`);
    const fillsWidth = layout.boardWidth >= layout.viewport - 2;
    report.push([
      "board fills the viewport",
      fillsWidth,
      `viewport ${layout.viewport}px, board ${layout.boardWidth}px, ${layout.columns} columns ${JSON.stringify(layout.columnWidths)}`,
    ]);
    report.push([
      "five columns rendered",
      layout.columns === 5,
      `${layout.columns} columns, ${layout.cards} cards`,
    ]);
    // Every state is a column in one row; a hardcoded grid count let the fifth
    // wrap to a second row, which no other check here noticed.
    report.push([
      "columns share one row",
      new Set(layout.columnTops).size === 1,
      `tops=${JSON.stringify(layout.columnTops)}`,
    ]);

    // open a card dialog with a real mouse click
    await cdp.clickCenter(".card");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const dialog = await cdp.evaluate(`(() => {
      const el = document.querySelector('#card-dialog');
      const r = el.getBoundingClientRect();
      return {
        display: getComputedStyle(el).display,
        width: Math.round(r.width),
        height: Math.round(r.height),
        viewport: [window.innerWidth, window.innerHeight],
        centredX: Math.abs(r.left + r.width / 2 - window.innerWidth / 2) <= 2,
        centredY: Math.abs(r.top + r.height / 2 - window.innerHeight / 2) <= 2,
        columns: getComputedStyle(el.querySelector('.dialog-columns')).gridTemplateColumns,
        heading: el.querySelector('h2')?.textContent ?? '',
        hasHistory: !!el.querySelector('.history'),
        historyItems: el.querySelectorAll('.history li').length,
      };
    })()`);
    const wide = dialog.width / dialog.viewport[0];
    const tall = dialog.height / dialog.viewport[1];
    report.push([
      "the card dialog opens centred, and big",
      dialog.display !== "none" &&
        dialog.heading.length > 0 &&
        dialog.hasHistory &&
        dialog.centredX &&
        dialog.centredY &&
        wide > 0.55 &&
        wide < 0.65 &&
        tall > 0.8 &&
        tall < 0.92 &&
        // Two columns — the panel is wide enough that one would stretch.
        dialog.columns.split(" ").length === 2,
      `"${dialog.heading}" · ${dialog.width}×${dialog.height} of ${dialog.viewport.join("×")} (${Math.round(wide * 100)}% × ${Math.round(tall * 100)}%) · centred=${dialog.centredX}/${dialog.centredY} · columns=${dialog.columns} · ${dialog.historyItems} history entries`,
    ]);

    // escape closes it
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const closed = await cdp.evaluate(
      `getComputedStyle(document.querySelector('#card-dialog')).display`,
    );
    report.push([
      "Escape closes the card dialog",
      closed === "none",
      `display: ${closed}`,
    ]);

    /* ---------------------------- languages ------------------------------ */

    const clickLang = async (lang) => {
      const box = await cdp.evaluate(`(() => {
        const b = document.querySelector('.lang-option[data-lang="${lang}"]');
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      await cdp.clickPoint(box.x, box.y);
      await new Promise((resolve) => setTimeout(resolve, 900));
    };

    // start on the board so column and drawer labels are in play
    await cdp.send("Page.navigate", { url: `${url}#/board` });
    await new Promise((resolve) => setTimeout(resolve, 700));

    const langState = async () =>
      JSON.parse(
        await cdp.evaluate(`JSON.stringify({
          lang: document.documentElement.lang,
          active: document.querySelector('.lang-option.active')?.dataset.route ?? document.querySelector('.lang-option.active')?.dataset.lang,
          columns: [...document.querySelectorAll('.column-header span:nth-child(2)')].map((e) => e.textContent),
          searchPlaceholder: document.getElementById('filter-q').placeholder,
          newCard: document.getElementById('new-card').textContent,
        })`),
      );

    await clickLang("en");
    const en = await langState();
    report.push([
      "English board labels",
      en.columns.join(",") === "Someday,Todo,Doing,Review,Done" &&
        en.active === "en" &&
        en.lang === "en",
      `columns=${en.columns.join("/")} · search="${en.searchPlaceholder}" · ${en.newCard}`,
    ]);

    await clickLang("zh");
    const zh = await langState();
    report.push([
      "Chinese board labels",
      zh.columns.join(",") === "搁置,待办,进行中,审查中,已完成" &&
        zh.active === "zh" &&
        zh.lang === "zh-CN",
      `columns=${zh.columns.join("/")} · search="${zh.searchPlaceholder}" · ${zh.newCard}`,
    ]);

    // the choice must survive a reload
    await cdp.send("Page.navigate", { url: `${url}#/board` });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const persisted = await langState();
    report.push([
      "language persists across reloads",
      persisted.active === "zh" && persisted.lang === "zh-CN",
      `active=${persisted.active} · lang=${persisted.lang}`,
    ]);

    // back to English for the remaining board assertions
    await clickLang("en");
    await cdp.send("Page.navigate", { url });
    await new Promise((resolve) => setTimeout(resolve, 700));

    /* ------------------------------ projects ----------------------------- */

    // the language block above navigates back to the docs home
    await cdp.send("Page.navigate", { url: `${url}#/board` });
    await new Promise((resolve) => setTimeout(resolve, 900));

    const projectUi = async () =>
      JSON.parse(
        await cdp.evaluate(`JSON.stringify({
          cards: [...document.querySelectorAll(".card-title")].map((e) => e.textContent),
          badges: [...document.querySelectorAll(".badge.project")].map((e) => e.textContent),
          options: [...document.querySelectorAll("#filter-project option")].map((o) => o.textContent),
        })`),
      );

    const all = await projectUi();
    report.push([
      "project badges and filter options render",
      all.cards.length === 12 &&
        all.badges.length === 10 &&
        all.options.includes("web") &&
        all.options.includes("api"),
      `${all.cards.length} cards · ${all.badges.length} badges · options=${all.options.join("/")}`,
    ]);

    await cdp.evaluate(`(() => {
      const s = document.getElementById("filter-project");
      s.value = "web";
      s.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const webOnly = await projectUi();
    report.push([
      "project filter narrows the board",
      // every surviving card is a web card, and nothing from api survives
      webOnly.cards.length > 1 &&
        webOnly.cards.every((title) => !title.includes("project: api")) &&
        webOnly.badges.every((badge) => badge === "project:web"),
      `cards=${webOnly.cards.join("/")}`,
    ]);

    // the dropdown still lists every project while a filter is active
    report.push([
      "project options survive the filter",
      webOnly.options.includes("api") && webOnly.options.includes("web"),
      `options=${webOnly.options.join("/")}`,
    ]);

    // clear it again so the rest of the check sees the whole board
    await cdp.evaluate(`(() => {
      const s = document.getElementById("filter-project");
      s.value = "";
      s.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 700));

    /* --------------------- column height and preview ---------------------- */

    const columnLayout = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 50,
        columns: [...document.querySelectorAll(".column")].map((c) => ({
          id: c.dataset.column,
          height: Math.round(c.getBoundingClientRect().height),
          scrolls: c.querySelector(".card-list").scrollHeight > c.querySelector(".card-list").clientHeight,
        })),
        donePreview: document.querySelector('[data-column="done"] .column-more')?.textContent ?? null,
        doneRendered: document.querySelectorAll('[data-column="done"] .card').length,
      })`),
    );
    report.push([
      "the board fits the viewport without scrolling the page",
      columnLayout.pageScrolls === false,
      `pageScrolls=${columnLayout.pageScrolls} · columns=${columnLayout.columns.map((c) => `${c.id}:${c.height}px`).join(" ")}`,
    ]);

    report.push([
      "the done column is previewed with a way to see the rest",
      /show the other \d+/.test(columnLayout.donePreview ?? "") &&
        columnLayout.doneRendered === 8,
      `preview="${columnLayout.donePreview}" · rendered=${columnLayout.doneRendered}`,
    ]);

    // expanding must reveal everything, including cards from another project
    await cdp.evaluate(
      `document.querySelector('[data-column="done"] .column-more')?.click()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    const expanded = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        rendered: document.querySelectorAll('[data-column="done"] .card').length,
        projects: [...new Set([...document.querySelectorAll('[data-column="done"] .badge.project')].map((b) => b.textContent))],
        collapse: document.querySelector('[data-column="done"] .column-more')?.textContent ?? null,
      })`),
    );
    report.push([
      "expanding the done column reveals every project's cards",
      expanded.rendered > 8 && expanded.projects.length >= 1,
      `rendered=${expanded.rendered} · projects=${expanded.projects.join("/")} · control="${expanded.collapse}"`,
    ]);

    /* --------------------- relations, notes, documents -------------------- */

    await cdp.send("Page.navigate", { url: `${url}#/board` });
    await new Promise((resolve) => setTimeout(resolve, 600));
    // The browser acts as the server's default actor, which created every
    // seeded card — so the mutations below are permitted.
    await cdp.send("Page.reload");
    await new Promise((resolve) => setTimeout(resolve, 900));

    // open the card that has both a relation and a note
    await cdp.evaluate(
      `[...document.querySelectorAll('.card')].find((c) => c.querySelector('.card-title')?.textContent === 'Design the REST API')?.click()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 600));

    const relations = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        fields: [...document.querySelectorAll('#card-dialog .field > label')].map((l) => l.textContent),
        downstream: [...document.querySelectorAll('#card-dialog .badge.relation')].map((b) => b.textContent),
      })`),
    );
    report.push([
      "the card dialog shows both ends of a relation",
      relations.fields.some((label) => label.startsWith("Upstream")) &&
        relations.fields.some((label) => label.startsWith("Downstream")) &&
        relations.downstream.some((chip) =>
          chip.includes("Write the MCP tool descriptions"),
        ),
      `fields=${relations.fields.join(" / ")} · downstream=${relations.downstream.join(" / ")}`,
    ]);

    const noteUi = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        text: document.querySelector('#card-dialog .note-text')?.textContent ?? '',
        link: document.querySelector('#card-dialog .note-link')?.textContent ?? '',
        badge: document.querySelector('.badge.notes')?.textContent ?? '',
      })`),
    );
    report.push([
      "a note shows its remark and its document link",
      noteUi.text === "the REST design doc" &&
        noteUi.link === "docs/rest-api.md",
      `text="${noteUi.text}" · link=${noteUi.link} · card badge="${noteUi.badge}"`,
    ]);

    // clicking the link reads the document from the server and renders it here
    await cdp.clickCenter("#card-dialog .note-link");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const viewer = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        visible: getComputedStyle(document.querySelector('#doc-viewer')).display !== 'none',
        heading: document.querySelector('#doc-viewer .markdown h1')?.textContent ?? '',
        strong: document.querySelector('#doc-viewer .markdown strong')?.textContent ?? '',
        listItems: document.querySelectorAll('#doc-viewer .markdown li').length,
        tableRows: document.querySelectorAll('#doc-viewer .markdown tbody tr').length,
        iframes: document.querySelectorAll('#doc-viewer iframe').length,
        scriptTags: document.querySelectorAll('#doc-viewer script').length,
      })`),
    );
    report.push([
      "the document viewer renders a local markdown doc",
      viewer.visible &&
        viewer.heading === "REST API design" &&
        viewer.strong === "event-sourced" &&
        viewer.listItems === 2 &&
        viewer.tableRows === 1 &&
        viewer.iframes === 0 &&
        viewer.scriptTags === 0,
      `heading="${viewer.heading}" · strong="${viewer.strong}" · ${viewer.listItems} list items · ${viewer.tableRows} table rows`,
    ]);

    // the rendered document is worth a screenshot of its own
    const docShot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(
      out.replace(/\.png$/, "") + "-doc.png",
      Buffer.from(docShot.data, "base64"),
    );

    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const docClosed = await cdp.evaluate(
      `getComputedStyle(document.querySelector('#doc-viewer')).display`,
    );
    report.push([
      "Escape closes the document viewer",
      docClosed === "none",
      `display: ${docClosed}`,
    ]);

    // and adding a relation from the UI writes the edge
    await cdp.evaluate(`(() => {
      const fields = [...document.querySelectorAll('#card-dialog .field')];
      const downstream = fields.find((f) => f.querySelector('label')?.textContent.startsWith('Downstream'));
      const input = downstream.querySelector('input');
      input.value = '3';
      const relate = [...downstream.querySelectorAll('button')].find((b) => b.textContent === 'Relate');
      relate.click();
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const addedRelation = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        downstream: [...document.querySelectorAll('#card-dialog .badge.relation')].map((b) => b.textContent),
        toasts: [...document.querySelectorAll('.toast')].map((toast) => toast.textContent),
      })`),
    );
    report.push([
      "adding a downstream relation from the UI works",
      addedRelation.downstream.some((chip) => chip.startsWith("#3")),
      `downstream=${addedRelation.downstream.join(" / ")} · toasts=${JSON.stringify(addedRelation.toasts)}`,
    ]);

    /* ------------------------------ docs page ----------------------------- */

    await cdp.send("Page.navigate", { url });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const docs = await cdp.evaluate(`(() => {
      const docs = document.querySelector('#docs');
      const board = document.querySelector('#board');
      return {
        docsVisible: getComputedStyle(docs).display !== 'none',
        boardHidden: getComputedStyle(board).display === 'none',
        sections: docs.querySelectorAll('.docs-section').length,
        headings: [...docs.querySelectorAll('.docs-section h2')].map((h) => h.textContent),
        tables: docs.querySelectorAll('.docs-table').length,
        codeBlocks: docs.querySelectorAll('.docs-section pre').length,
        tocLinks: docs.querySelectorAll('.docs-toc a').length,
        hero: docs.querySelector('.docs-hero h1')?.textContent ?? '',
        cta: docs.querySelector('.docs-cta')?.getAttribute('href') ?? '',
        activeNav: document.querySelector('.nav-link.active')?.dataset.route ?? '',
        // The measure the audit log has to match, taken where it is defined.
        layoutWidth: Math.round(document.querySelector('.docs-layout').getBoundingClientRect().width),
      };
    })()`);
    report.push([
      "docs is the home page",
      docs.docsVisible && docs.boardHidden && docs.activeNav === "docs",
      `hero "${docs.hero}" · nav=${docs.activeNav} · board hidden=${docs.boardHidden}`,
    ]);
    report.push([
      "docs content rendered",
      docs.sections >= 7 &&
        docs.tables >= 4 &&
        docs.codeBlocks >= 2 &&
        docs.tocLinks === docs.sections,
      `${docs.sections} sections · ${docs.tables} tables · ${docs.codeBlocks} code blocks · ${docs.tocLinks} toc links`,
    ]);
    report.push([
      "docs cover the whole product",
      [
        "The workflow",
        "Connecting an agent",
        "Build your own UI",
        "Troubleshooting",
      ].every((title) => docs.headings.includes(title)),
      docs.headings.join(" / "),
    ]);

    // the table of contents must scroll, not just change the hash
    const tocBefore = await cdp.evaluate(
      `Math.round(document.querySelector('#docs').scrollTop)`,
    );
    const tocBox = await cdp.evaluate(`(() => {
      const link = [...document.querySelectorAll('.docs-toc a')].find((a) => a.dataset.section === 'api');
      const r = link.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await cdp.clickPoint(tocBox.x, tocBox.y);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const tocAfter = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        scrollTop: Math.round(document.querySelector('#docs').scrollTop),
        hash: window.location.hash,
        active: document.querySelector('.docs-toc a.active')?.dataset.section ?? null,
        sectionTop: Math.round(document.querySelector('#docs-api').getBoundingClientRect().top),
        stillOnDocs: getComputedStyle(document.querySelector('#docs')).display !== 'none',
      })`),
    );
    report.push([
      "table of contents scrolls to the section",
      tocAfter.scrollTop > tocBefore + 200 &&
        tocAfter.active === "api" &&
        tocAfter.stillOnDocs,
      `scroll ${tocBefore}→${tocAfter.scrollTop} · active=${tocAfter.active} · section top ${tocAfter.sectionTop}px`,
    ]);

    // the hero CTA must reach the board with the token intact
    // (scroll the docs container back to the top first — the TOC click moved it)
    await cdp.evaluate(`document.querySelector('#docs').scrollTo({ top: 0 })`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await cdp.clickCenter(".docs-cta");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterCta = await cdp.evaluate(`(() => ({
      route: window.location.hash,
      token: new URLSearchParams(window.location.search).get('token'),
      boardVisible: getComputedStyle(document.querySelector('#board')).display !== 'none',
      docsHidden: getComputedStyle(document.querySelector('#docs')).display === 'none',
      navActive: document.querySelector('.nav-link.active')?.dataset.route ?? '',
    }))()`);
    report.push([
      "hero CTA opens the board and keeps the token",
      afterCta.route === "#/board" &&
        afterCta.boardVisible &&
        afterCta.docsHidden &&
        afterCta.token !== null,
      `hash=${afterCta.route} token=${afterCta.token ? "kept" : "lost"} nav=${afterCta.navActive}`,
    ]);

    // and a mutation still works after navigating
    const createdAfterNav = await cdp.evaluate(`(async () => {
      const token = new URLSearchParams(window.location.search).get('token') ?? '';
      const response = await fetch('/api/cards' + (token ? '?token=' + encodeURIComponent(token) : ''), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Actor-Name': 'browser-check' },
        body: JSON.stringify({ title: 'created from the board view' }),
      });
      return response.status;
    })()`);
    report.push([
      "mutation works after navigation",
      createdAfterNav === 201,
      `status ${createdAfterNav}`,
    ]);

    // back to docs through the nav
    await cdp.clickCenter('.nav-link[data-route="docs"]');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const backToDocs = await cdp.evaluate(
      `getComputedStyle(document.querySelector('#docs')).display !== 'none'`,
    );
    report.push(["nav returns to docs", backToDocs]);

    // the new-card modal is board-only, so return to the board first
    await cdp.clickCenter('.nav-link[data-route="board"]');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await cdp.clickCenter("#new-card");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const modal = await cdp.evaluate(`(() => {
      const el = document.querySelector('#modal');
      const box = el.getBoundingClientRect();
      // Every field measured against the modal's own box: one that hangs out
      // of it is the overflow this check exists for.
      const strays = [...el.querySelectorAll('.field')].filter((f) => {
        const b = f.getBoundingClientRect();
        return b.right > box.right + 0.5 || b.left < box.left - 0.5;
      }).length;
      const project = el.querySelector('.project-picker select');
      return {
        display: getComputedStyle(el).display,
        inputs: el.querySelectorAll('input, textarea').length,
        buttons: [...el.querySelectorAll('button')].map((b) => b.textContent),
        width: Math.round(box.width),
        fitsWidth: el.scrollWidth <= el.clientWidth,
        fitsHeight: box.top >= -0.5 && box.bottom <= window.innerHeight + 0.5,
        strays,
        // The caret is drawn in CSS, so the platform's own arrow must be off —
        // two arrows on one select is what this pins down.
        projectAppearance: project ? getComputedStyle(project).appearance : null,
        projectCaret: el.querySelector('.project-picker')
          ? getComputedStyle(el.querySelector('.project-picker'), '::after').content
          : null,
        projectOptions: project
          ? [...project.options].map((o) => o.value || '(none)')
          : null,
      };
    })()`);
    report.push([
      "new-card modal opens",
      modal.display !== "none" && modal.inputs >= 4,
      `${modal.inputs} fields, buttons: ${modal.buttons.join(" / ")}`,
    ]);
    report.push([
      "the new-card modal holds its own box",
      modal.fitsWidth && modal.fitsHeight && modal.strays === 0,
      `${modal.width}px wide · ${modal.strays} fields outside the box · fits the window: ${modal.fitsHeight}`,
    ]);
    report.push([
      "project is a dropdown of the projects in use",
      Array.isArray(modal.projectOptions) &&
        modal.projectOptions.includes("api") &&
        modal.projectOptions.includes("web"),
      `options: ${(modal.projectOptions ?? []).join(" / ")}`,
    ]);
    report.push([
      "the project picker draws one arrow, not two",
      modal.projectAppearance === "none" &&
        modal.projectCaret !== "none" &&
        modal.projectCaret !== "",
      `appearance: ${modal.projectAppearance} · caret: ${modal.projectCaret}`,
    ]);
    // "new project…" trades the list for a text box, so a slug the board has
    // not seen yet can still be typed.
    await cdp.evaluate(`(() => {
      const select = document.querySelector('.project-picker select');
      select.value = '__new';
      select.dispatchEvent(new Event('change'));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const typer = JSON.parse(
      await cdp.evaluate(`(() => {
        const picker = document.querySelector('.project-picker');
        return JSON.stringify({
          listGone: picker.querySelector('select').hidden,
          boxShown: !picker.querySelector('.project-typer').hidden,
          focused: document.activeElement?.type ?? '',
        });
      })()`),
    );
    report.push([
      "an unseen project can still be typed",
      typer.listGone && typer.boxShown && typer.focused === "text",
      `list hidden: ${typer.listGone} · text box shown: ${typer.boxShown} · focus: ${typer.focused}`,
    ]);
    // click a corner — the centre of the backdrop is covered by the modal itself
    await cdp.clickPoint(6, 6);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const modalClosed = await cdp.evaluate(
      `getComputedStyle(document.querySelector('#modal')).display`,
    );
    report.push([
      "backdrop click closes the modal",
      modalClosed === "none",
      `display: ${modalClosed}`,
    ]);

    /* ------------------------------- events ------------------------------ */

    await cdp.clickCenter('.nav-link[data-route="events"]');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const eventsPage = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        active: document.querySelector('.nav-link.active')?.dataset.route ?? null,
        rows: document.querySelectorAll('.event-row').length,
        cards: [...document.querySelectorAll('.event-card')].filter((el) => /^#\\d+/.test(el.textContent)).length,
        header: document.querySelector('.events-header h1')?.textContent ?? '',
        projects: document.querySelectorAll('.events-project option').length,
        pagerButtons: document.querySelectorAll('.event-pager button').length,
        position: document.querySelector('.event-position')?.textContent ?? '',
      })`),
    );
    report.push([
      "events page lists the log, with a project filter and a pager",
      eventsPage.active === "events" &&
        eventsPage.rows > 0 &&
        eventsPage.cards > 0 &&
        eventsPage.projects >= 2 &&
        eventsPage.pagerButtons === 4 &&
        /Page 1/.test(eventsPage.position),
      `active=${eventsPage.active} · rows=${eventsPage.rows} · card refs=${eventsPage.cards} · projects=${eventsPage.projects} · position="${eventsPage.position}"`,
    ]);

    // The audit log is a page like the others, in the docs page's measure and
    // one type size up from it, opening at 25 rows and saying how many events
    // there are in total.
    const eventsLook = JSON.parse(
      await cdp.evaluate(`(() => {
        const row = document.querySelector('.event-row');
        const size = document.querySelector('.events-size');
        const position = document.querySelector('.event-position')?.textContent ?? '';
        const totals = /(\\d+) of (\\d+)/.exec(position);
        return JSON.stringify({
          panelWidth: Math.round(document.querySelector('.event-panel').getBoundingClientRect().width),
          head: [...document.querySelectorAll('.event-head > *')].map((c) => c.textContent),
          cells: [...document.querySelector('.event-row').children].map((c) => c.classList[0]),
          titleFont: parseFloat(getComputedStyle(document.querySelector('.events-header h1')).fontSize),
          rowFont: parseFloat(getComputedStyle(row).fontSize),
          rowBorder: getComputedStyle(document.querySelector('.event-pager button')).borderTopWidth,
          autoLabel: size?.querySelector('option[value="auto"]')?.textContent ?? '',
          chosen: size?.value ?? '',
          sizes: [...document.querySelectorAll('.events-size')].map((s) => s.value),
          inPager: [...document.querySelectorAll('.events-size')].every((s) => s.closest('.event-pager')),
          refreshIcon: Boolean(document.querySelector('.events-controls button svg')),
          refreshText: document.querySelector('.events-controls button')?.textContent ?? '',
          refreshLabel: document.querySelector('.events-controls button')?.getAttribute('aria-label') ?? '',
          position,
          shown: totals ? Number(totals[1]) : 0,
          total: totals ? Number(totals[2]) : 0,
        });
      })()`),
    );
    report.push([
      "events is laid out as the docs page, in the docs page's measure",
      eventsLook.panelWidth === docs.layoutWidth &&
        eventsLook.head.join(",") === "Time,Project,Card,Event,Actor,Source" &&
        eventsLook.cells.join(",") ===
          [
            "event-time",
            "event-project",
            "event-card",
            "event-desc",
            "event-actor",
            "event-source",
          ].join(",") &&
        eventsLook.titleFont >= 32 &&
        eventsLook.rowFont >= 15.5 &&
        // A real button, not the browser's default grey chrome.
        eventsLook.rowBorder !== "auto" &&
        eventsLook.rowBorder !== "0px",
      `panel=${eventsLook.panelWidth}px · docs=${docs.layoutWidth}px · head=${eventsLook.head.join("/")} · cells=${eventsLook.cells.join("/")} · title=${eventsLook.titleFont}px · row=${eventsLook.rowFont}px · button border=${eventsLook.rowBorder}`,
    ]);
    report.push([
      "the audit log opens at 25 a page, and the pager counts the whole log",
      eventsLook.chosen === "25" &&
        eventsPage.rows === 25 &&
        eventsLook.shown === 25 &&
        eventsLook.total > eventsLook.shown,
      `per page=${eventsLook.chosen} · ${eventsPage.rows} rows · position="${eventsLook.position}"`,
    ]);
    report.push([
      "the row budget rides with the pager, and refresh is a glyph",
      eventsLook.inPager &&
        eventsLook.sizes.length === 2 &&
        eventsLook.sizes.every((value) => value === "25") &&
        eventsLook.refreshIcon &&
        eventsLook.refreshText.trim() === "" &&
        eventsLook.refreshLabel !== "",
      `size selects=${eventsLook.sizes.join("/")} in pager=${eventsLook.inPager} · refresh svg=${eventsLook.refreshIcon} text="${eventsLook.refreshText.trim()}" label="${eventsLook.refreshLabel}"`,
    ]);

    // ...and `auto` is the escape hatch for "give me a screenful", which is what
    // it has to do if a reader is ever going to pick it.
    await cdp.evaluate(`(() => {
      const size = document.querySelector('.events-size');
      size.value = 'auto';
      size.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const autoFit = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        rows: document.querySelectorAll('.event-row').length,
        listBottom: Math.round(document.querySelector('.event-list').getBoundingClientRect().bottom),
        viewport: window.innerHeight,
        // Choosing on one pager has to choose on the other, too.
        sizes: [...document.querySelectorAll('.events-size')].map((s) => s.value),
      })`),
    );
    report.push([
      "choosing `auto` fits the window instead, on both pagers",
      autoFit.rows > 0 &&
        autoFit.rows !== 25 &&
        autoFit.listBottom <= autoFit.viewport + 2 &&
        autoFit.sizes.join(",") === "auto,auto",
      `${autoFit.rows} rows · list ends at ${autoFit.listBottom}px of ${autoFit.viewport}px · size selects=${autoFit.sizes.join("/")}`,
    ]);
    // back to the default, so the screenshot is the page as it opens
    await cdp.evaluate(`(() => {
      const size = document.querySelector('.events-size');
      size.value = '25';
      size.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 900));

    // back to the board, so the final screenshot is the board
    await cdp.clickCenter('.nav-link[data-route="board"]');
    await new Promise((resolve) => setTimeout(resolve, 500));

    // The modal, end to end: fill it, create, and find the card on the board.
    // Last, because it writes to the board the assertions above just read.
    await cdp.clickCenter("#new-card");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await cdp.evaluate(`(() => {
      const modal = document.querySelector('#modal');
      // text inputs in document order: title, assignee, reviewer
      modal.querySelectorAll('input[type="text"]')[0].value = 'created from the modal';
      modal.querySelector('.project-picker select').value = 'web';
    })()`);
    await cdp.clickCenter(".modal-actions button.primary");
    await new Promise((resolve) => setTimeout(resolve, 800));
    const created = await cdp.evaluate(
      `[...document.querySelectorAll('.card-title')].some((n) => n.textContent === 'created from the modal')`,
    );
    const createdProject = await cdp.evaluate(
      `[...document.querySelectorAll('.card')].find((c) => c.querySelector('.card-title')?.textContent === 'created from the modal')?.textContent ?? ''`,
    );
    report.push([
      "a card created in the modal lands on the board, in its project",
      created && /project:web/.test(createdProject),
      `on the board: ${created} · ${createdProject.trim()}`,
    ]);

    // screenshot the final state
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(out, Buffer.from(shot.data, "base64"));

    cdp.close();

    /* ------------------------------- report ------------------------------ */

    console.log(`\nbrowser check — ${url}`);
    let failures = 0;
    for (const [label, ok, detail] of report) {
      console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
      if (!ok) failures += 1;
    }
    console.log(
      cdp.consoleErrors.length === 0
        ? "✓ no console errors"
        : `✗ ${cdp.consoleErrors.length} console error(s):\n    ${cdp.consoleErrors.join("\n    ")}`,
    );
    if (cdp.consoleErrors.length > 0) failures += 1;
    console.log(`  screenshot → ${out}\n`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    if (server) void server.close().catch(() => undefined);
    cleanup();
  }
}

main().catch((error) => {
  console.error(`browser check failed: ${error.message}`);
  process.exit(1);
});
