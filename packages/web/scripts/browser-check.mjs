#!/usr/bin/env node
/**
 * Zero-dependency browser check: drives headless Chrome over the DevTools
 * Protocol using Node's built-in WebSocket. No Playwright, no Puppeteer.
 *
 *   node scripts/browser-check.mjs [--url <url>] [--out <file>] [--width 1600]
 *
 * It screenshots the page, asserts the layout, exercises the drawer and modal,
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
    // above — the two things the drawer has to render from either end.
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
      for (const selector of ['#drawer', '#modal', '#drawer-backdrop', '#modal-backdrop']) {
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

    // open a card drawer with a real mouse click
    await cdp.clickCenter(".card");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const drawer = await cdp.evaluate(`(() => {
      const el = document.querySelector('#drawer');
      const r = el.getBoundingClientRect();
      return {
        display: getComputedStyle(el).display,
        width: Math.round(r.width),
        heading: el.querySelector('h2')?.textContent ?? '',
        hasHistory: !!el.querySelector('.history'),
        historyItems: el.querySelectorAll('.history li').length,
      };
    })()`);
    report.push([
      "drawer opens on click",
      drawer.display !== "none" && drawer.heading.length > 0,
      `"${drawer.heading}" · ${drawer.width}px wide · ${drawer.historyItems} history entries`,
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
      `getComputedStyle(document.querySelector('#drawer')).display`,
    );
    report.push([
      "Escape closes the drawer",
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
          actingAs: document.querySelector('.identity label').textContent,
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
      `columns=${en.columns.join("/")} · ${en.actingAs} · ${en.newCard}`,
    ]);

    await clickLang("zh");
    const zh = await langState();
    report.push([
      "Chinese board labels",
      zh.columns.join(",") === "搁置,待办,进行中,审查中,已完成" &&
        zh.active === "zh" &&
        zh.lang === "zh-CN",
      `columns=${zh.columns.join("/")} · ${zh.actingAs} · ${zh.newCard}`,
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
    // Act as the card's creator, so the mutations below are permitted — the
    // board's permissions are cooperative and based on the actor name.
    await cdp.evaluate(
      `localStorage.setItem('using-kanban.actor', JSON.stringify({ name: 'jyxc', type: 'human' }))`,
    );
    // a same-document navigation would keep the old identity in memory
    await cdp.send("Page.reload");
    await new Promise((resolve) => setTimeout(resolve, 900));

    // open the card that has both a relation and a note
    await cdp.evaluate(
      `[...document.querySelectorAll('.card')].find((c) => c.querySelector('.card-title')?.textContent === 'Design the REST API')?.click()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 600));

    const relations = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        fields: [...document.querySelectorAll('#drawer .field > label')].map((l) => l.textContent),
        downstream: [...document.querySelectorAll('#drawer .badge.relation')].map((b) => b.textContent),
      })`),
    );
    report.push([
      "the drawer shows both ends of a relation",
      relations.fields.some((label) => label.startsWith("Upstream")) &&
        relations.fields.some((label) => label.startsWith("Downstream")) &&
        relations.downstream.some((chip) =>
          chip.includes("Write the MCP tool descriptions"),
        ),
      `fields=${relations.fields.join(" / ")} · downstream=${relations.downstream.join(" / ")}`,
    ]);

    const noteUi = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        text: document.querySelector('#drawer .note-text')?.textContent ?? '',
        link: document.querySelector('#drawer .note-link')?.textContent ?? '',
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
    await cdp.clickCenter("#drawer .note-link");
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
      const fields = [...document.querySelectorAll('#drawer .field')];
      const downstream = fields.find((f) => f.querySelector('label')?.textContent.startsWith('Downstream'));
      const input = downstream.querySelector('input');
      input.value = '3';
      const relate = [...downstream.querySelectorAll('button')].find((b) => b.textContent === 'Relate');
      relate.click();
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const addedRelation = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        downstream: [...document.querySelectorAll('#drawer .badge.relation')].map((b) => b.textContent),
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
      return {
        display: getComputedStyle(el).display,
        inputs: el.querySelectorAll('input, textarea').length,
        buttons: [...el.querySelectorAll('button')].map((b) => b.textContent),
      };
    })()`);
    report.push([
      "new-card modal opens",
      modal.display !== "none" && modal.inputs >= 4,
      `${modal.inputs} fields, buttons: ${modal.buttons.join(" / ")}`,
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
