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
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "@using-kanban/server";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = 9222;

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}

let url = flag("url", "http://127.0.0.1:48080/");
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
      throw new Error(`page js failed: ${result.exceptionDetails.text}`);
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
  if (!(await isReachable(url))) {
    const dir = mkdtempSync(join(tmpdir(), "ukb-browser-board-"));
    server = await startServer({
      dir,
      uiDir: new URL("../src", import.meta.url).pathname,
      port: Number(new URL(url).port) || 48080,
      token: "browser-check",
    });
    const base = `http://127.0.0.1:${server.port}`;
    for (const title of [
      "Design the REST API",
      "Write the MCP tool descriptions",
    ]) {
      await fetch(`${base}/api/cards?token=browser-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Actor-Name": "jyxc" },
        body: JSON.stringify({
          title,
          body: "AC: verified in a browser",
          reviewer: "jyxc",
        }),
      });
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
      "four columns rendered",
      layout.columns === 4,
      `${layout.columns} columns, ${layout.cards} cards`,
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

    // the hero CTA must reach the board with the token intact
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

async function isReachable(target) {
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(`browser check failed: ${error.message}`);
  process.exit(1);
});
