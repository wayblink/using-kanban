import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";
import { HttpError, sendJson } from "../http.js";
import type { RequestContext } from "../router.js";

/** Documents a note may point at. Anything else is not served. */
const DOC_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdown",
  ".mkd",
  ".html",
  ".htm",
  ".txt",
  ".text",
]);

/** Images too, because a markdown doc embeds them and they must resolve. */
const RAW_EXTENSIONS = new Set([
  ...DOC_EXTENSIONS,
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
]);

const MAX_DOC_BYTES = 2_000_000;

const CONTENT_TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".mdown": "text/markdown; charset=utf-8",
  ".mkd": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".text": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

export type DocKind = "markdown" | "html" | "text";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd"]);

function kindFor(ext: string): DocKind {
  if (ext === ".html" || ext === ".htm") return "html";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  return "text";
}

/**
 * `GET /api/doc?path=<path>` — the document behind a card note.
 *
 * A note's link is often a file on this machine rather than a URL (`docs/
 * design.md` in the repo the card is about), so the Web UI asks the server for
 * the content instead of trying to read the filesystem from a browser.
 *
 * Containment is the point: the path must resolve inside one of the allowed
 * roots — the `--doc-root` directories, the store directory, or the server's
 * working directory. `..` cannot climb out, and only document extensions are
 * served, so this is not a general file reader.
 *
 * This route always needs the token, even on loopback: it reads files off the
 * machine, which is a different thing from reading the board.
 */
export function getDoc(ctx: RequestContext): void {
  const raw = ctx.query.get("path");
  if (raw === null || raw.trim() === "") {
    throw new HttpError(400, "invalid_input", "?path= is required");
  }

  const file = resolveDocPath(raw, ctx.options.docRoots, ctx.options.dir);
  const ext = extname(file).toLowerCase();
  if (!RAW_EXTENSIONS.has(ext)) {
    throw new HttpError(
      400,
      "invalid_input",
      `only documents can be read (${[...RAW_EXTENSIONS].sort().join(", ")})`,
    );
  }
  if (!isFile(file)) {
    throw new HttpError(404, "not_found", `no document at ${raw}`);
  }
  if (sizeOf(file) > MAX_DOC_BYTES) {
    throw new HttpError(
      413,
      "payload_too_large",
      `document exceeds ${MAX_DOC_BYTES} bytes`,
    );
  }

  if (ctx.query.get("raw") === "1") {
    // Streamed as-is: markdown images and HTML docs reference it directly.
    const res: ServerResponse = ctx.res;
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      // A document is content, never code — this is what stops a linked SVG
      // or HTML file from running script in the UI's origin. Images still
      // load: they come from this same endpoint.
      "Content-Security-Policy":
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
    });
    createReadStream(file).pipe(res);
    return;
  }

  const content = readFileSync(file, "utf8");
  sendJson(ctx.res, 200, {
    path: file,
    name: basename(file),
    kind: kindFor(ext),
    content,
  });
}

/** Resolves a note's link to a file inside one of the allowed roots. */
export function resolveDocPath(
  raw: string,
  docRoots: readonly string[],
  storeDir: string,
): string {
  const requested = expandHome(raw.replace(/^file:\/\//, ""));
  const roots = [...docRoots, storeDir, process.cwd()].map((root) =>
    resolve(root),
  );

  // A relative link is resolved against every root in turn: the first one that
  // exists wins, so `docs/design.md` works from whichever root has it.
  const candidates = isAbsolute(requested)
    ? [resolve(requested)]
    : roots.map((root) => resolve(root, requested));

  for (const candidate of candidates) {
    if (isInsideAny(candidate, roots) && existsSync(candidate))
      return candidate;
  }

  // Nothing existed — report the first candidate so the error names a path the
  // reader can act on, and so a traversal attempt still fails closed.
  const first = candidates[0];
  if (first === undefined || !isInsideAny(first, roots)) {
    throw new HttpError(
      403,
      "forbidden",
      `${raw} is outside the directories documents may come from`,
    );
  }
  return first;
}

function isInsideAny(candidate: string, roots: readonly string[]): boolean {
  return roots.some(
    (root) => candidate === root || candidate.startsWith(root + sep),
  );
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
