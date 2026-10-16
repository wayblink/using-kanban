/**
 * The real launch, end to end: the CLI's `web` verb, its banner, its OS-chosen
 * port and its generated token.
 *
 * The unit suite drives `launchWebServer` with a fake child, which cannot see
 * the parts that only exist between two processes — that `ukb web` writes a URL
 * before it blocks, that the URL is really answering, and that SIGTERM really
 * stops it. This suite pays for a real server for a second to see all three.
 *
 * It spawns `dist/bin.js` because that is what the extension launches; the root
 * `test` script builds first. See bin.test.ts for the same reasoning.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDetachedWebSpawner,
  launchWebServer,
  type WebServer,
} from "../../pi/extensions/using-kanban/web-command.js";

const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const tempDirs: string[] = [];
let running: WebServer | null = null;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ukb-web-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  // A failed assertion must not leave a server behind for the next test.
  await running?.stop();
  running = null;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("launchWebServer against the real CLI", () => {
  it("serves the Web UI and stops when the session is done with it", async () => {
    const launch = await launchWebServer({
      // `--port 0` is the CLI's own default; it proves the URL is read from the
      // banner rather than assembled from flags this side could have known.
      argv: [
        "web",
        "--no-open",
        "--port",
        "0",
        "--dir",
        tempDir(),
        "--storage",
        "memory",
      ],
      spawn: createDetachedWebSpawner({ script: bin }),
    });
    if (!launch.ok) throw new Error(`expected a launch, got ${launch.error}`);
    running = launch.server;

    expect(launch.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    const response = await fetch(launch.server.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>");

    await launch.server.stop();
    expect(launch.server.exited).toBe(true);
    // The port is released, not just the process adopted.
    await expect(fetch(launch.server.url)).rejects.toThrow();
  });
});
