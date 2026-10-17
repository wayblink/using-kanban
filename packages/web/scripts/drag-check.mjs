#!/usr/bin/env node
/**
 * Drag-and-drop check, driven with Playwright (a devDependency).
 *
 * The zero-dependency browser-check.mjs covers layout and panels; HTML5
 * drag-and-drop needs real drag events, which is what this adds.
 *
 *   pnpm --filter @wayblink/using-kanban-web drag-check
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startServer } from "@wayblink/using-kanban-server";

const dir = mkdtempSync(join(tmpdir(), "ukb-drag-board-"));
const server = await startServer({
  dir,
  uiDir: new URL("../src", import.meta.url).pathname,
  port: 48099,
  token: "drag-check",
  // The browser has no identity picker — it acts as the server's default
  // actor, so that is the name the drag below is expected to claim as.
  actor: { name: "playwright", type: "agent" },
});
const base = `http://127.0.0.1:${server.port}`;

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.message));

try {
  await page.goto(`${base}/?token=drag-check#/board`, {
    waitUntil: "networkidle",
  });

  // seed a card through the API, acting as the human
  const created = await fetch(`${base}/api/cards?token=drag-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Actor-Name": "jyxc" },
    body: JSON.stringify({
      title: "Drag me to doing",
      body: "AC: lands in DOING, assigned to the acting identity",
      assignee: "claude-code",
      reviewer: "jyxc",
    }),
  });
  const { card } = await created.json();
  await page.reload({ waitUntil: "networkidle" });

  const cardSelector = `.card:has-text("Drag me to doing")`;
  const before = await page.locator(cardSelector).count();
  check("card rendered in TODO", before === 1);

  // the browser acts as the server's default actor — playwright, an agent
  await page.dragAndDrop(
    cardSelector,
    '.column[data-column="doing"] .card-list',
  );
  await page.waitForTimeout(600);

  const after = await fetch(`${base}/api/cards/${card.id}`).then((r) =>
    r.json(),
  );
  check(
    "drop on DOING claims the card",
    after.card.state === "doing",
    `state=${after.card.state} assignee=${after.card.assignee}`,
  );
  check(
    "assigned to the acting identity",
    after.card.assignee === "playwright",
  );

  // the history should record the claim by the browser's actor
  const history = await fetch(`${base}/api/cards/${card.id}/history`).then(
    (r) => r.json(),
  );
  const moved = history.events
    .filter((event) => event.type === "card.moved")
    .at(-1);
  check(
    "event attributed to the browser identity",
    moved?.actor.name === "playwright" && moved.source === "api",
    `${moved?.actor.type}/${moved?.actor.name} via ${moved?.source}`,
  );

  // dragging back to TODO reopens it
  await page.dragAndDrop(
    '.column[data-column="doing"] .card',
    '.column[data-column="todo"] .card-list',
  );
  await page.waitForTimeout(600);
  const reopened = await fetch(`${base}/api/cards/${card.id}`).then((r) =>
    r.json(),
  );
  check(
    "drop back on TODO reopens",
    reopened.card.state === "todo",
    `state=${reopened.card.state}`,
  );

  await page.screenshot({ path: "/tmp/ukb-drag-check.png", fullPage: false });
  check(
    "no console errors",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 2).join(" | "),
  );
} finally {
  await browser.close();
  await server.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`  screenshot → /tmp/ukb-drag-check.png\n`);
process.exitCode = failures === 0 ? 0 : 1;
