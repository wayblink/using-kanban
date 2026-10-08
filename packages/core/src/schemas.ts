import { z } from "zod";
import { CARD_STATES, EVENT_SOURCES, EVENT_TYPES } from "./types.js";

export const CardStateSchema = z.enum(CARD_STATES);
export const EventSourceSchema = z.enum(EVENT_SOURCES);
export const EventTypeSchema = z.enum(EVENT_TYPES);
export const ActorTypeSchema = z.enum(["human", "agent"]);

export const ActorSchema = z.object({
  type: ActorTypeSchema,
  name: z.string().min(1, "must not be empty"),
});

/* ------------------------------------------------------------------ *
 * Inputs (validated at the front door)
 * ------------------------------------------------------------------ */

/** Optional text fields: `undefined` = leave as-is, `null` = clear. */
export const ClearableTextSchema = z.string().nullish();

export const AddCardInputSchema = z.object({
  title: z.string().trim().min(1, "must not be empty"),
  body: ClearableTextSchema,
  assignee: ClearableTextSchema,
  reviewer: ClearableTextSchema,
  blockedBy: z.array(z.number().int().positive()).default([]),
});
export type AddCardInput = z.input<typeof AddCardInputSchema>;

export const EditCardInputSchema = z.object({
  title: z.string().trim().min(1, "must not be empty").optional(),
  body: ClearableTextSchema,
  assignee: ClearableTextSchema,
  reviewer: ClearableTextSchema,
});
export type EditCardInput = z.input<typeof EditCardInputSchema>;

export const MutationOptionsSchema = z.object({
  expectedRevision: z.number().int().positive().optional(),
});
export type MutationOptions = z.input<typeof MutationOptionsSchema>;

/* ------------------------------------------------------------------ *
 * Event payloads (validated when replaying the log)
 * ------------------------------------------------------------------ */

export const CardPatchSchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().nullable().optional(),
  assignee: z.string().nullable().optional(),
  reviewer: z.string().nullable().optional(),
});
export type CardPatch = z.infer<typeof CardPatchSchema>;

export const MoveActionSchema = z.enum([
  "move",
  "claim",
  "review",
  "done",
  "reopen",
]);
export type MoveAction = z.infer<typeof MoveActionSchema>;

export const CardCreatedPayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string().nullable(),
  assignee: z.string().nullable(),
  reviewer: z.string().nullable(),
  blockedBy: z.array(z.number().int().positive()),
  createdBy: z.string().min(1),
});
export type CardCreatedPayload = z.infer<typeof CardCreatedPayloadSchema>;

export const CardUpdatedPayloadSchema = z.object({ patch: CardPatchSchema });
export type CardUpdatedPayload = z.infer<typeof CardUpdatedPayloadSchema>;

export const CardMovedPayloadSchema = z.object({
  from: CardStateSchema,
  to: CardStateSchema,
  action: MoveActionSchema,
  patch: CardPatchSchema.optional(),
});
export type CardMovedPayload = z.infer<typeof CardMovedPayloadSchema>;

export const CardDependencyPayloadSchema = z.object({
  blockedBy: z.number().int().positive(),
});
export type CardDependencyPayload = z.infer<typeof CardDependencyPayloadSchema>;

/** A fully-stored event row, used by the JSONL log. */
export const StoredEventSchema = z.object({
  id: z.number().int().positive(),
  ts: z.string().min(1),
  actor: ActorSchema,
  source: EventSourceSchema,
  type: EventTypeSchema,
  cardId: z.number().int().positive(),
  payload: z.record(z.unknown()),
});
export type StoredEvent = z.infer<typeof StoredEventSchema>;

/** A raw SQLite row from the `events` table. */
export const EventRowSchema = z.object({
  id: z.number(),
  ts: z.string(),
  actor_type: z.string().min(1),
  actor_name: z.string().min(1),
  source: EventSourceSchema,
  type: EventTypeSchema,
  card_id: z.number(),
  payload: z.string(),
});
