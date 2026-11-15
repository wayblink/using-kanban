/**
 * ukb — DeepSeek Harness bundle for using-kanban.
 *
 * The DSH counterpart of `packages/pi`: one `ukb` tool, one `/ukb` command, and
 * the board guidance in the system prompt. Every read and write is the `ukb`
 * CLI; there is no board logic here at all.
 *
 * Differences from the Pi extension, all forced by the host:
 *  - no overlay panel (DSH plugins render through slots, not a TUI) — humans use
 *    `/ukb web`;
 *  - no per-turn digest yet: DSH has no pre-turn message hook that is guaranteed
 *    to land before the turn's first step, so the digest would arrive late.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";

import { defineTool } from "@deepseek-ai/dsh-tools";

import { ACTIONS, COLUMNS, DIRECTIONS, PRIORITIES, buildArgs, splitTokens } from "./src/args.js";
import { renderGuidance, resolveGuidance } from "./src/guidance.js";
import { resolveUkb } from "./src/resolve.js";

export const name = "ukb";

export const inject = ["tools", "agents"];

const TOOL_NAME = "ukb";
const SECTION_NAME = "tool:ukb";
const SECTION_ORDER = 151;
const AGENT_NAME = "dsh";
const MAX_OUTPUT_CHARS = 24_000;

const TOOL_DESCRIPTION = [
  "The shared kanban board (ukb): list and read cards, claim work, move it through review,",
  "and record notes. Use it as your todo list for anything another agent or a human may need to see.",
  "`mine` first, `show` before acting, `claim` before starting, `review` when ready.",
  "Card bodies hold target files and acceptance criteria.",
].join(" ");

/** @param {string} text */
function boundOutput(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const cut = text.lastIndexOf("\n", MAX_OUTPUT_CHARS);
  const end = cut > 0 ? cut : MAX_OUTPUT_CHARS;
  return `${text.slice(0, end)}\n… (output truncated at ${MAX_OUTPUT_CHARS} chars — re-read with show <id> or a narrower board --project)`;
}

/**
 * Run the CLI. Never rejects for a non-zero exit: exit 1 is a usage error and
 * exit 2 is a `KanbanError` printed as `code: message` on stderr; the caller
 * decides what to show.
 *
 * @param {import("./src/resolve.js").UkbCommand} cli
 * @param {readonly string[]} argv
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ code: number, output: string }>}
 */
function runUkb(cli, argv, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli.command, [...cli.prefix, ...argv], {
      env: { ...process.env, ...cli.env, UKB_AGENT_TYPE: "agent" },
      stdio: ["ignore", "pipe", "pipe"],
      ...(signal === undefined ? {} : { signal }),
    });
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const err = [];
    child.stdout?.on("data", (chunk) => out.push(String(chunk)));
    child.stderr?.on("data", (chunk) => err.push(String(chunk)));
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      const text = [...out, ...err].join("").trim() || "(no output)";
      resolve({ code: code ?? 1, output: text });
    });
  });
}

/**
 * @param {boolean} ok
 * @param {string} text
 */
function commandResult(ok, text) {
  return { kind: ok ? "success" : "error", text };
}

export function apply(ctx, rowConfig = {}) {
  const guidance = resolveGuidance(rowConfig.guidance);
  const cli = resolveUkb(rowConfig.ukb_path);

  if (cli === null) {
    ctx.logger?.warn?.(
      "[ukb] the `ukb` CLI was not found (set ukb_path in the bundle config, or install the CLI). The tool will report this on each call.",
    );
  } else {
    ctx.logger?.info?.(`[ukb] using ${cli.source}`);
  }

  /** @param {readonly string[]} argv @param {AbortSignal | undefined} signal */
  const invoke = async (argv, signal) => {
    if (cli === null) {
      return { code: 2, output: "ukb CLI not found: set ukb_path in the bundle config or put `ukb` on PATH." };
    }
    // Identity goes last: the CLI's parser accepts global flags after positionals.
    return runUkb(cli, [...argv, "--agent", AGENT_NAME, "--agent-type", "agent"], signal);
  };

  const systemPrompt = ctx.get("systemPrompt");
  if (systemPrompt !== undefined) {
    ctx.effect(() =>
      systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: renderGuidance(guidance),
      }),
    );
  }

  ctx.tools.register(
    defineTool({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      parameters: {
        action: {
          type: "string",
          enum: [...ACTIONS],
          required: true,
          description:
            "mine = your open cards (start here); board/list = the whole board; show = one card with body, notes and history; claim before starting; review/done/reopen; add/edit/move; block/parent/relate for structure; note for paperwork.",
        },
        id: { type: "integer", description: "Card id for the single-card verbs" },
        ids: {
          type: "array",
          items: { type: "integer" },
          description: "Several card ids for review/done/reopen/delete (claim accepts several so the CLI can refuse)",
        },
        title: { type: "string", description: "add/edit: card title" },
        body: {
          type: "string",
          description: "add/edit: the card body — target files and acceptance criteria",
        },
        column: {
          type: "string",
          enum: [...COLUMNS],
          description: "move: target column; someday parks a card and clears its owner",
        },
        priority: { type: "string", enum: [...PRIORITIES], description: "add/edit: priority" },
        assignee: { type: "string", description: "add/edit: assignee name" },
        reviewer: { type: "string", description: "add/edit: reviewer name" },
        blockedBy: { type: "integer", description: "add/block: the card that must finish first" },
        project: { type: "string", description: "Project slug, or the board slice for mine/board" },
        other: { type: "integer", description: "relate/unrelate: the card on the other end" },
        parent: { type: "integer", description: "parent: the umbrella card" },
        direction: {
          type: "string",
          enum: [...DIRECTIONS],
          description: "relate: which side `other` sits on relative to `id`",
        },
        noteId: { type: "integer", description: "note-edit/note-remove: the note id shown by show" },
        text: { type: "string", description: "note: the remark line; note-edit: the new remark" },
        url: { type: "string", description: "note/note-edit: https://… or a path on this machine" },
        json: { type: "boolean", description: "list/board: machine-readable output" },
        brief: { type: "boolean", description: "board: one line per card" },
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }],
      },
      timeoutMs: 60_000,
      async execute(args, exec) {
        const params = /** @type {import("./src/args.js").UkbParams} */ (args);
        const { code, output } = await invoke(buildArgs(params), exec.signal);
        if (code !== 0) throw new Error(boundOutput(output));
        return boundOutput(output);
      },
    }),
  );

  const commands = ctx.get("commands");
  if (commands !== undefined) {
    ctx.effect(() =>
      commands.register({
        name: "ukb",
        description:
          "using-kanban — no args lists your cards; `help` prints the CLI help; any other input passes through to the ukb CLI",
        input: { hint: "[mine|board|show <id>|claim <id>|web|help]" },
        handler: async ({ rawInput, signal }) => {
          const tokens = splitTokens((rawInput ?? "").trim());
          const argv = tokens.length === 0 ? ["mine"] : tokens;
          try {
            const { code, output } = await invoke(argv, signal);
            return commandResult(code === 0, output);
          } catch (error) {
            return commandResult(false, error instanceof Error ? error.message : String(error));
          }
        },
      }),
    );
  }

  /* ------------------------------ web panel data ----------------------------- */

  // The browser half (client.js) renders a board panel and a composer chip, and
  // both need data the browser cannot reach. One exact route answers them; it is
  // a GET reader over the same CLI the tool uses, cached briefly so a polling
  // chip does not fork a process per second.
  // `ctx.get` is empty during apply; the route registers when the service is
  // actually available, which is also when a profile without a webserver keeps
  // this block dormant instead of failing the plugin.
  ctx.inject(["webServer"], (scope) => {
    const webServer = scope.webServer;
    /** @type {{ at: number, key: string, value: unknown }} */
    const cache = { at: 0, key: "", value: null };

    // Who the board belongs to: the human owner from the ukb config (or the
    // machine name), and the agent name this bundle acts as. The panel filters
    // by both, so it must not guess them from the browser.
    const readIdentity = () => {
      /** @type {{ owner: string | null, agent: string }} */
      const identity = { owner: process.env.UKB_OWNER?.trim() || null, agent: AGENT_NAME };
      if (identity.owner !== null) return identity;
      try {
        const home = process.env.HOME ?? "";
        const base = process.env.XDG_CONFIG_HOME?.trim() || `${home}/.config`;
        const raw = JSON.parse(readFileSync(`${base}/ukb/config.json`, "utf8"));
        if (typeof raw?.owner === "string" && raw.owner.trim() !== "") identity.owner = raw.owner.trim();
      } catch {
        // No config file: fall through to the OS account name.
      }
      if (identity.owner === null) {
        try {
          identity.owner = userInfo().username;
        } catch {
          identity.owner = null;
        }
      }
      return identity;
    };

    /** @param {string | null} project */
    const readBoard = async (project) => {
      const key = project ?? "";
      if (Date.now() - cache.at < 4_000 && cache.key === key) return cache.value;
      const argv = ["board", "--json", "--brief", ...(project === null ? [] : ["--project", project])];
      const { code, output } = await invoke(argv, undefined);
      if (code !== 0) throw new Error(output);
      const value = { ...JSON.parse(output), identity: readIdentity(), generatedAt: new Date().toISOString() };
      cache.at = Date.now();
      cache.key = key;
      cache.value = value;
      return value;
    };

    // Card detail: the panel expands a card in place, and `ukb show` is the only
    // source for a body and its history.
    ctx.effect(() =>
      webServer.register({
        kind: "exact",
        path: "/api/ukb/card",
        resource: async (request) => {
          const id = new URL(request.url).searchParams.get("id") ?? "";
          if (!/^[0-9]+$/u.test(id)) {
            return new Response(JSON.stringify({ error: "invalid card id" }), {
              status: 400,
              headers: { "content-type": "application/json; charset=utf-8" },
            });
          }
          try {
            const { code, output } = await invoke(["show", id], undefined);
            if (code !== 0) {
              return new Response(JSON.stringify({ error: output }), {
                status: 502,
                headers: { "content-type": "application/json; charset=utf-8" },
              });
            }
            return new Response(JSON.stringify({ id: Number(id), text: output }), {
              headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
            });
          } catch (error) {
            return new Response(
              JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
              { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
            );
          }
        },
      }),
    );

    ctx.effect(() =>
      webServer.register({
        kind: "exact",
        path: "/api/ukb/board",
        resource: async (request) => {
          try {
            const url = new URL(request.url);
            const project = url.searchParams.get("project");
            const body = await readBoard(project === null || project === "" ? null : project);
            return new Response(JSON.stringify(body), {
              headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
            });
          } catch (error) {
            return new Response(
              JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
              { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
            );
          }
        },
      }),
    );
  });
}
