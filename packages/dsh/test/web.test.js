import assert from "node:assert/strict";
import test from "node:test";

import { extractServerUrl, launchWebServer, remoteWebUrl } from "../src/web.js";

/**
 * The launcher is the one place the bundle does something other than await a
 * short CLI call: it starts a detached server and reads the URL out of the
 * banner. These tests pin the two decisions a regression would break — where
 * the URL comes from, and which board a full screen should open.
 */

test("the server URL is the CLI's own banner, token included", () => {
  const banner =
    "\nusing-kanban — http://127.0.0.1:51234/?token=abc123\n  store  /Users/me/.ukb (sqlite)\n";
  assert.equal(
    extractServerUrl(banner),
    "http://127.0.0.1:51234/?token=abc123",
  );
});

test("a URL cut off by a chunk boundary is not reported as working", () => {
  // No trailing whitespace yet: the port may still be growing.
  assert.equal(extractServerUrl("using-kanban — http://127.0.0.1:5123"), null);
  assert.equal(
    extractServerUrl("using-kanban — http://127.0.0.1:51234/?token=abc \n"),
    "http://127.0.0.1:51234/?token=abc",
  );
});

test("a remote board is opened, not started", () => {
  assert.equal(
    remoteWebUrl({ UKB_SERVER: "https://kb.example.com" }, { server: "" }),
    "https://kb.example.com",
  );
  assert.equal(
    remoteWebUrl({}, { server: " https://kb.example.com " }),
    "https://kb.example.com",
  );
  // No configured server: a local board, so there is nothing to open.
  assert.equal(remoteWebUrl({}, { owner: "me" }), null);
  assert.equal(remoteWebUrl({ UKB_SERVER: "  " }, {}), null);
});

/** A child process stand-in: the launcher only touches these members. */
function fakeChild() {
  const stdoutListeners = [];
  const stderrListeners = [];
  const exitListeners = [];
  const errorListeners = [];
  const killed = [];
  const destroyed = { stdout: false, stderr: false };
  let unrefed = false;

  return {
    stdout: {
      on(event, listener) {
        assert.equal(event, "data");
        stdoutListeners.push(listener);
      },
      destroy() {
        destroyed.stdout = true;
      },
    },
    stderr: {
      on(event, listener) {
        assert.equal(event, "data");
        stderrListeners.push(listener);
      },
      destroy() {
        destroyed.stderr = true;
      },
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    onError(listener) {
      errorListeners.push(listener);
    },
    kill(signal = "SIGTERM") {
      killed.push(signal);
      return true;
    },
    unref() {
      unrefed = true;
    },
    /* test controls */
    emitStdout(text) {
      for (const listener of stdoutListeners) listener(Buffer.from(text));
    },
    emitStderr(text) {
      for (const listener of stderrListeners) listener(Buffer.from(text));
    },
    emitExit(code, signal = null) {
      for (const listener of exitListeners) listener(code, signal);
    },
    emitError(error) {
      for (const listener of errorListeners) listener(error);
    },
    get killed() {
      return killed;
    },
    get unrefed() {
      return unrefed;
    },
    get destroyed() {
      return destroyed;
    },
  };
}

test("a launch resolves once the banner arrives, then detaches", async () => {
  const child = fakeChild();
  const pending = launchWebServer({
    argv: ["web", "--no-open"],
    spawn: (argv) => {
      assert.deepEqual(argv, ["web", "--no-open"]);
      return child;
    },
    detachDelayMs: 5,
  });

  child.emitStdout("using-kanban — http://127.0.0.1:51234/?token=ab");
  child.emitStdout("c \n");
  const launched = await pending;
  assert.equal(launched.ok, true);
  assert.equal(launched.server.url, "http://127.0.0.1:51234/?token=abc");
  assert.equal(launched.server.exited, false);

  // Outliving the Host is the point, and a "waited for" child would hold it.
  assert.equal(child.unrefed, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(child.destroyed.stdout, true);

  const stopping = launched.server.stop();
  assert.deepEqual(child.killed, ["SIGTERM"]);
  child.emitExit(null, "SIGTERM");
  await stopping;
  assert.equal(launched.server.exited, true);
});

test("a CLI that exits before serving reports its own output", async () => {
  const child = fakeChild();
  const pending = launchWebServer({
    argv: ["web"],
    spawn: () => child,
  });
  child.emitStderr("ukb web: port 7000 is taken\n");
  child.emitExit(1);
  const launched = await pending;
  assert.equal(launched.ok, false);
  assert.equal(launched.code, 1);
  assert.match(launched.error, /exited before serving \(code 1\)/);
  assert.match(launched.error, /port 7000 is taken/);
});

test("a server that never prints a URL is killed, not leaked", async () => {
  const child = fakeChild();
  const pending = launchWebServer({
    argv: ["web"],
    spawn: () => child,
    startTimeoutMs: 5,
  });
  // Keep the loop alive past the unref'd timeout the launcher armed.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const launched = await pending;
  assert.equal(launched.ok, false);
  assert.match(launched.error, /reported no URL/);
  assert.deepEqual(child.killed, ["SIGKILL"]);
});

test("a spawn failure is a launch failure, not a crash", async () => {
  const launched = await launchWebServer({
    argv: ["web"],
    spawn: () => {
      throw new Error("spawn ukb EACCES");
    },
  });
  assert.equal(launched.ok, false);
  assert.match(launched.error, /could not start ukb web — spawn ukb EACCES/);
});
