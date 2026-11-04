/**
 * config.ts — the Pi front door's view of the shared config file.
 *
 * The file itself (`~/.config/ukb/config.json`) is read by one module for the
 * whole product now, in `@wayblink/using-kanban-config`: the CLI, the MCP
 * server and the HTTP server behind the Web UI read the same bytes, so one
 * machine has one `owner`, one default agent, and one place to fix a typo. The
 * Pi tool adds nothing on top — re-exporting keeps every existing import here
 * (`loadConfig`, the overlay types, the guidance validators) working unchanged.
 *
 * Read once at extension load; changing it needs a Pi restart.
 */

export * from "@wayblink/using-kanban-config";
