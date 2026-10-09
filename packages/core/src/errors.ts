/** Stable error codes — front doors map these to MCP tool errors / HTTP statuses. */
export type KanbanErrorCode =
  | "invalid_input"
  | "card_not_found"
  | "board_not_found"
  | "invalid_state"
  | "claim_conflict"
  | "forbidden"
  | "revision_conflict"
  | "internal_error";

export class KanbanError extends Error {
  readonly code: KanbanErrorCode;

  constructor(code: KanbanErrorCode, message: string) {
    super(message);
    this.name = "KanbanError";
    this.code = code;
  }
}
