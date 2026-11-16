import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { acceptsGzip, GZIP_MIN_BYTES, sendJson } from "./http.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Types whose bytes shrink under gzip; images and fonts do not. */
const COMPRESSIBLE = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".map",
  ".svg",
  ".txt",
]);

/**
 * Serves a static UI bundle from `uiDir` at `/`.
 *
 * Returns true when the request was handled (or answered with 404 from inside
 * the UI dir) so the caller knows not to fall through.
 */
export function serveStaticUi(
  res: ServerResponse,
  uiDir: string,
  pathname: string,
): boolean {
  const root = resolve(uiDir);
  if (!existsSync(root)) return false;

  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(join(root, normalize(requested)));

  // Path traversal guard: the resolved file must stay inside the UI dir.
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    sendJson(res, 403, {
      error: { code: "forbidden", message: "path outside the UI directory" },
    });
    return true;
  }

  const target = isFile(filePath) ? filePath : join(root, "index.html");
  if (!isFile(target)) {
    sendJson(res, 404, {
      error: { code: "not_found", message: "no UI bundle found" },
    });
    return true;
  }

  const stats = statSync(target);
  const contentType =
    CONTENT_TYPES[extname(target)] ?? "application/octet-stream";
  // The built UI is one inlined HTML file of a few hundred KB. A weak ETag
  // makes a reload a 304 instead of downloading it again.
  const etag = `W/"${stats.size}-${Math.floor(stats.mtimeMs)}"`;
  const ifNoneMatch = res.req?.headers["if-none-match"];
  const matches =
    typeof ifNoneMatch === "string" &&
    ifNoneMatch
      .split(",")
      .map((value) => value.trim())
      .includes(etag);
  if (matches) {
    res.writeHead(304, {
      ETag: etag,
      "Cache-Control": "no-cache",
      Vary: "Accept-Encoding",
    });
    res.end();
    return true;
  }

  if (
    stats.size >= GZIP_MIN_BYTES &&
    COMPRESSIBLE.has(extname(target)) &&
    acceptsGzip(res)
  ) {
    const compressed = gzipSync(readFileSync(target));
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": compressed.length,
      "Content-Encoding": "gzip",
      "Cache-Control": "no-cache",
      ETag: etag,
      Vary: "Accept-Encoding",
    });
    res.end(compressed);
    return true;
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stats.size,
    "Cache-Control": "no-cache",
    ETag: etag,
    Vary: "Accept-Encoding",
  });
  createReadStream(target).pipe(res);
  return true;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
