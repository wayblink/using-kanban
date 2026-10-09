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
  process.exit(code);
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`ukb: ${error.message}\n`);
    process.exit(1);
  }
  if (error instanceof KanbanError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(
    `ukb: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
