/**
 * How an agent finds out who it is and who the human is.
 *
 * The config file is passed in rather than read here — the bin reads it at the
 * edge — so these cases do not depend on what this machine has configured.
 */
import { describe, expect, it } from "vitest";
import type { UkbConfig } from "@wayblink/using-kanban-config";
import { resolveMcpOptions } from "../src/options.js";

const config: UkbConfig = { owner: "jyxc", agent: "pi" };

describe("resolveMcpOptions", () => {
  it("takes the agent name from a flag, then the environment, then the file", () => {
    expect(resolveMcpOptions(["--agent", "codex"], {}, config).actor.name).toBe(
      "codex",
    );
    expect(
      resolveMcpOptions([], { UKB_AGENT: "opencode" }, config).actor.name,
    ).toBe("opencode");
    expect(resolveMcpOptions([], {}, config).actor.name).toBe("pi");
    expect(resolveMcpOptions([], {}, {}).actor.name).toBe("agent");
  });

  it("reports whether the agent name was a generic fallback", () => {
    // The bin warns about this: an agent nobody named gets attributed to
    // "agent", which tells the reader nothing about who did the work.
    expect(resolveMcpOptions([], {}, {}).usedDefaultAgent).toBe(true);
    expect(resolveMcpOptions([], {}, config).usedDefaultAgent).toBe(false);
    expect(resolveMcpOptions(["--agent", "x"], {}, {}).usedDefaultAgent).toBe(
      false,
    );
  });

  it("resolves the owner from the file, and defaults to the machine", () => {
    expect(resolveMcpOptions([], {}, config).owner).toBe("jyxc");
    // No owner configured: the machine's name, pinned here via the override so
    // the assertion does not depend on the host running the suite.
    expect(
      resolveMcpOptions([], { UKB_MACHINE_NAME: "workshop" }, {}).owner,
    ).toBe("workshop");
  });

  it("lets UKB_OWNER override the file", () => {
    expect(
      resolveMcpOptions([], { UKB_OWNER: "someone-else" }, config).owner,
    ).toBe("someone-else");
  });

  it("keeps the store and storage resolution untouched", () => {
    const options = resolveMcpOptions(
      ["--dir", "/tmp/board", "--storage", "jsonl"],
      {},
      config,
    );
    expect(options.dir).toBe("/tmp/board");
    expect(options.storage).toBe("jsonl");
    expect(options.actor.type).toBe("agent");
  });
});

describe("remote transport", () => {
  it("takes the server and token from flags, then environment, then the file", () => {
    const env = {
      UKB_SERVER: "https://env.example.com",
      UKB_TOKEN: "env-token",
    };
    const fromEnv = resolveMcpOptions([], env, {});
    expect(fromEnv.server).toBe("https://env.example.com");
    expect(fromEnv.token).toBe("env-token");

    const fromFlags = resolveMcpOptions(
      ["--server", "https://flag.example.com", "--token", "flag-token"],
      env,
      {},
    );
    expect(fromFlags.server).toBe("https://flag.example.com");
    expect(fromFlags.token).toBe("flag-token");

    const fromFile = resolveMcpOptions(
      [],
      {},
      {
        server: "https://file.example.com",
      },
    );
    expect(fromFile.server).toBe("https://file.example.com");
  });

  it("stays local when nothing names a server", () => {
    const options = resolveMcpOptions([], {}, {});
    expect(options.server).toBeNull();
    expect(options.token).toBeNull();
  });
});
