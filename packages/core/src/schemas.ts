import { z } from "zod";
import {
  CARD_STATES,
  EVENT_SOURCES,
  EVENT_TYPES,
  RELATION_DIRECTIONS,
} from "./types.js";

export const CardStateSchema = z.enum(CARD_STATES);
export const EventSourceSchema = z.enum(EVENT_SOURCES);
export const EventTypeSchema = z.enum(EVENT_TYPES);
export const ActorTypeSchema = z.enum(["human", "agent"]);
export const RelationDirectionSchema = z.enum(RELATION_DIRECTIONS);

export const ActorSchema = z.object({
  type: ActorTypeSchema,
  name: z.string().min(1, "must not be empty"),
});

/* ------------------------------------------------------------------ *
 * Inputs (validated at the front door)
 * ------------------------------------------------------------------ */

/** Optional text fields: `undefined` = leave as-is, `null` = clear. */
export const ClearableTextSchema = z.string().nullish();

/**
 * A project slug. Deliberately restrictive — it ends up in URLs, CLI flags and
 * file names, and agents pass it around as an opaque token. Lowercase so that
 * "Web" and "web" cannot become two different projects by accident.
 */
export const ProjectSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "must not be empty")
  .max(64, "at most 64 characters")
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "lowercase letters, digits, dot, dash or underscore",
  );

/** Optional project field: `undefined` = leave as-is, `null` = clear. */
export const ClearableProjectSchema = ProjectSchema.nullish();

export const AddCardInputSchema = z.object({
  title: z.string().trim().min(1, "must not be empty"),
  body: ClearableTextSchema,
  assignee: ClearableTextSchema,
  reviewer: ClearableTextSchema,
  project: ClearableProjectSchema,
  blockedBy: z.array(z.number().int().positive()).default([]),
});
export type AddCardInput = z.input<typeof AddCardInputSchema>;

export const EditCardInputSchema = z.object({
  title: z.string().trim().min(1, "must not be empty").optional(),
  body: ClearableTextSchema,
  assignee: ClearableTextSchema,
  reviewer: ClearableTextSchema,
  project: ClearableProjectSchema,
});
export type EditCardInput = z.input<typeof EditCardInputSchema>;

/* ---------------------------------- notes --------------------------------- */

/**
 * A document link. Deliberately loose: `https://…` for hosted docs, and plain
 * paths (`docs/design.md`, `~/notes/x.html`) for files on this machine — the
 * Web UI renders local markdown and HTML itself, so a note can point at a file
 * that lives in a repo rather than somewhere served.
 */
export const NoteUrlSchema = z
  .string()
  .trim()
  .min(1, "must not be empty")
  .max(2048, "at most 2048 characters");

/** A stored note, as it appears in a `card.created` payload. */
export const CardNoteSchema = z.object({
  id: z.number().int().positive(),
  text: z.string().min(1),
  url: z.string().nullable().default(null),
  createdBy: z.string().min(1),
  createdAt: z.string().min(1),
});
export type CardNotePayload = z.infer<typeof CardNoteSchema>;

export const AddNoteInputSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, "must not be empty")
    .max(4000, "at most 4000 characters"),
  url: NoteUrlSchema.nullish(),
});
export type AddNoteInput = z.input<typeof AddNoteInputSchema>;

export const UpdateNoteInputSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1, "must not be empty")
      .max(4000, "at most 4000 characters")
      .optional(),
    url: NoteUrlSchema.nullish(),
  })
  .refine((value) => value.text !== undefined || value.url !== undefined, {
    message: "nothing to update — pass text and/or url",
  });
export type UpdateNoteInput = z.input<typeof UpdateNoteInputSchema>;

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
  project: z.string().nullable().optional(),
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
  /** Absent on events written before projects existed. */
  project: z.string().nullable().default(null),
  blockedBy: z.array(z.number().int().positive()),
  /** Absent on events written before notes existed. */
  notes: z.array(CardNoteSchema).default([]),
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

export const NoteAddedPayloadSchema = z.object({
  text: z.string().min(1),
  url: z.string().nullable().default(null),
});
export type NoteAddedPayload = z.infer<typeof NoteAddedPayloadSchema>;

export const NoteUpdatedPayloadSchema = z.object({
  note: z.number().int().positive(),
  patch: z.object({
    text: z.string().min(1).optional(),
    url: z.string().nullable().optional(),
  }),
});
export type NoteUpdatedPayload = z.infer<typeof NoteUpdatedPayloadSchema>;

export const NoteRemovedPayloadSchema = z.object({
  note: z.number().int().positive(),
});
export type NoteRemovedPayload = z.infer<typeof NoteRemovedPayloadSchema>;

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
