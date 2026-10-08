#!/usr/bin/env node
/**
 * Inlines style.css and app.js into a single self-contained dist/index.html,
 * so the default UI can be shipped (or dropped into another product) as one
 * file with no build step and no dependencies.
 *
 *   node scripts/inline.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");
const distDir = join(here, "..", "dist");

const html = readFileSync(join(srcDir, "index.html"), "utf8");
const css = readFileSync(join(srcDir, "style.css"), "utf8");
const js = readFileSync(join(srcDir, "app.js"), "utf8");

const inlined = html
  .replace(
    '<link rel="stylesheet" href="./style.css" />',
    () => `<style>\n${css}\n</style>`,
  )
  .replace(
    '<script type="module" src="./app.js"></script>',
    () => `<script type="module">\n${js}\n</script>`,
  );

if (inlined.includes("./style.css") || inlined.includes("./app.js")) {
  throw new Error(
    "inlining failed: an asset reference is still present in the output",
  );
}

mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, "index.html"), inlined, "utf8");

const kb = (Buffer.byteLength(inlined, "utf8") / 1024).toFixed(1);
process.stdout.write(`dist/index.html — ${kb} KB, self-contained\n`);
