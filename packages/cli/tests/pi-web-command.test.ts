/**
 * `/ukb web` — the CLI's one non-returning verb, launched in the background.
 *
 * The module lives in packages/pi; see pi-overlay-render.test.ts for why this
 * suite exercises it. The launcher takes its `spawn` as an argument for exactly
 * this reason: a fake child can serve a banner, refuse to die, or fail to spawn
 * without a real server or a real port in the picture.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  WEB_DETACH_DELAY_MS,
  extractServerUrl,
  launchWebServer,
  parseWebCommand,
  type WebChildProcess,
} from "../../pi/extensions/using-kanban/web-command.js";

class FakeStream extends EventEmitter {
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeChild implements WebChildProcess {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly killed: NodeJS.Signals[] = [];
  readonly unref = vi.fn();
  #exitListeners: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  #errorListeners: Array<(error: Error) => void> = [];

  onExit(
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void {
    this.#exitListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.#errorListeners.push(listener);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    // A real SIGKILL always lands; SIGTERM is for the tests that make the
    // server ignore it.
    if (signal === "SIGKILL") this.exit(0, signal);
    return true;
  }

  /** The CLI's startup banner, as `ukb web` prints it. */
  serve(url: string): void {
    this.stdout.emit("data", Buffer.from(`using-kanban — ${url}\n`));
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    for (const listener of this.#exitListeners.splice(0))
      listener(code, signal);
  }

  fail(error: Error): void {
    for (const listener of this.#errorListeners.splice(0)) listener(error);
  }
}

describe("parseWebCommand", () => {
  it("starts the server when nothing follows the verb", () => {
    expect(parseWebCommand([])).toEqual({
      action: "start",
      args: [],
      error: null,
    });
  });

  it("hands flags to the CLI verbatim", () => {
    expect(parseWebCommand(["--port", "4000", "--no-open"])).toEqual({
      action: "start",
      args: ["--port", "4000", "--no-open"],
      error: null,
    });
  });

  it("recognises stop", () => {
    expect(parseWebCommand(["stop"])).toEqual({
      action: "stop",
      args: [],
      error: null,
    });
  });

  it("refuses arguments to stop, and bare words to start", () => {
    expect(parseWebCommand(["stop", "now"]).error).toContain(
      "stop takes no arguments",
    );
    expect(parseWebCommand(["now"]).error).toContain(
      "unknown ukb web argument: now",
    );
  });
});

describe("extractServerUrl", () => {
  it("reads the URL out of the CLI's banner", () => {
    expect(
      extractServerUrl(
        "using-kanban — http://127.0.0.1:51234/?token=abc\n  store  /tmp/.ukb\n",
      ),
    ).toBe("http://127.0.0.1:51234/?token=abc");
  });

  it("waits for the end of the URL rather than reporting half of one", () => {
    // The launcher runs this over a growing buffer, chunk by chunk.
    expect(
      extractServerUrl("using-kanban — http://127.0.0.1:1/?token=ab"),
    ).toBe(null);
    expect(
      extractServerUrl("using-kanban — http://127.0.0.1:1/?token=abc\n"),
    ).toBe("http://127.0.0.1:1/?token=abc");
  });

  it("does not invent a URL", () => {
    expect(extractServerUrl("")).toBeNull();
    expect(
      extractServerUrl("  store  /Users/someone/.ukb (sqlite)\n"),
    ).toBeNull();
  });
});

describe("launchWebServer", () => {
  it("starts the CLI's web verb, detached", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const spawn = vi.fn(() => child);
    const pending = launchWebServer({
      argv: ["--agent", "pi", "web", "--no-open"],
      spawn,
    });

    child.serve("http://127.0.0.1:51234/?token=abc");
    const launch = await pending;

    expect(spawn).toHaveBeenCalledWith(["--agent", "pi", "web", "--no-open"]);
    if (!launch.ok) throw new Error(`expected a launch, got ${launch.error}`);
    expect(launch.server.url).toBe("http://127.0.0.1:51234/?token=abc");
    expect(launch.server.exited).toBe(false);
    // The child must not hold Pi's event loop, but the pipes stay readable for
    // one beat so a write still in flight cannot die of EPIPE.
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.stdout.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(WEB_DETACH_DELAY_MS);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    vi.useRealTimers();
  });

  it("reports the CLI's own reason when it exits before serving", async () => {
    const child = new FakeChild();
    const pending = launchWebServer({ argv: ["web"], spawn: () => child });
    child.stderr.emit(
      "data",
      Buffer.from("ukb: listen EADDRINUSE: address already in use\n"),
    );
    child.exit(1);

    const launch = await pending;
    expect(launch.ok).toBe(false);
    if (launch.ok) return;
    expect(launch.error).toContain("exited before serving (code 1)");
    expect(launch.error).toContain("EADDRINUSE");
    expect(launch.code).toBe(1);
  });

  it("reports a CLI that cannot be spawned at all", async () => {
    const child = new FakeChild();
    const pending = launchWebServer({ argv: ["web"], spawn: () => child });
    child.fail(new Error("spawn EACCES"));

    const launch = await pending;
    expect(launch.ok).toBe(false);
    if (launch.ok) return;
    expect(launch.error).toContain("spawn EACCES");
    expect(launch.code).toBeNull();
  });

  it("survives a spawner that throws", async () => {
    const launch = await launchWebServer({
      argv: ["web"],
      spawn: () => {
        throw new Error("boom");
      },
    });
    expect(launch.ok).toBe(false);
    if (launch.ok) return;
    expect(launch.error).toContain("boom");
  });

  it("gives up on a CLI that never prints a URL, and kills it", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const pending = launchWebServer({
      argv: ["web"],
      spawn: () => child,
      startTimeoutMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    const launch = await pending;
    expect(launch.ok).toBe(false);
    expect(child.killed).toEqual(["SIGKILL"]);
    vi.useRealTimers();
  });

  it("stops the server with SIGTERM, and knows when it is gone", async () => {
    const child = new FakeChild();
    const pending = launchWebServer({
      argv: ["web"],
      spawn: () => child,
      stopTimeoutMs: 20,
    });
    child.serve("http://127.0.0.1:1/?token=t");
    const launch = await pending;
    if (!launch.ok) throw new Error(`expected a launch, got ${launch.error}`);

    const stop = launch.server.stop();
    expect(child.killed).toEqual(["SIGTERM"]);
    child.exit(0, "SIGTERM");
    await stop;

    expect(child.killed).toEqual(["SIGTERM"]);
    expect(launch.server.exited).toBe(true);
    await launch.server.stop();
    expect(child.killed).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const child = new FakeChild();
    const pending = launchWebServer({
      argv: ["web"],
      spawn: () => child,
      stopTimeoutMs: 20,
    });
    child.serve("http://127.0.0.1:1/?token=t");
    const launch = await pending;
    if (!launch.ok) throw new Error(`expected a launch, got ${launch.error}`);

    await launch.server.stop();
    expect(child.killed).toEqual(["SIGTERM", "SIGKILL"]);
    expect(launch.server.exited).toBe(true);
  });
});
