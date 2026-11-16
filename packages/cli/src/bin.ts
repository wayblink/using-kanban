#!/usr/bin/env node
import { KanbanError } from "@wayblink/using-kanban-core";
import { runCommand } from "./commands.js";
import { UsageError } from "./argv.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const io = {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text: string) => process.stdout.write(`${text}\n`),
    stderr: (text: string) =>
      process.stderr.write(text.endsWith("\n") ? text : `${text}\n`),
  };

  const code = await runCommand(argv, io);
  // Do not call process.exit() here. When stdout is a pipe (as it is under the
  // Pi extension), write() is asynchronous; forcing the process down can cut a
  // large JSON document at the platform pipe buffer (64 KiB on macOS). Setting
  // exitCode lets Node drain stdout/stderr before exiting naturally.
  process.exitCode = code;
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`ukb: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (error instanceof KanbanError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  // A refused configuration (a non-loopback bind with no account, say) is a
  // setup step, not a broken command: honor the code it carries so a
  // supervisor can tell EX_CONFIG (78) from a real failure. Read it
  // structurally — the server package is imported lazily and may be bundled
  // under a different module instance than this file.
  const configExit = (error as { exitCode?: unknown } | null)?.exitCode;
  if (typeof configExit === "number" && Number.isInteger(configExit)) {
    process.stderr.write(
      `ukb: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = configExit;
    return;
  }
  process.stderr.write(
    `ukb: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
