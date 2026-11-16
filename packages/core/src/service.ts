/**
 * The board interface, and the local implementation.
 *
 * Both doors — local SQLite and the remote HTTP transport — implement this
 * contract so the CLI and MCP server never branch on where the board lives.
 * Every method returns a Promise even locally: the remote can only answer
 * asynchronously, and a sync-only local type would let a call site forget an
 * `await` that matters the moment `UKB_SERVER` is set.
 */
import type { Kanban, MutationResult } from "./kanban.js";
import type {
  AddCardInput,
  AddNoteInput,
  EditCardInput,
  MutationOptions,
  UpdateNoteInput,
} from "./schemas.js";
import type {
  Actor,
  Board,
  Card,
  CardState,
  Event,
  EventSource,
  ProjectSummary,
  RelationDirection,
} from "./types.js";

export interface BoardService {
  board(project?: string | null, subproject?: string | null): Promise<Board>;
  cards(): Promise<Card[]>;
  card(id: number): Promise<Card | null>;
  history(id: number): Promise<Event[]>;
  mine(
    assignee: string,
    project?: string | null,
    subproject?: string | null,
  ): Promise<Card[]>;
  reviewQueue(
    reviewer: string,
    project?: string | null,
    subproject?: string | null,
  ): Promise<Card[]>;
  childrenOf(id: number): Promise<Card[]>;
  projects(): Promise<string[]>;
  projectSummary(): Promise<ProjectSummary[]>;

  add(
    input: AddCardInput,
    actor: Actor,
    source?: EventSource,
  ): Promise<MutationResult>;
  edit(
    id: number,
    input: EditCardInput,
    actor: Actor,
    source?: EventSource,
    options?: MutationOptions,
  ): Promise<MutationResult>;
  claim(
    id: number,
    actor: Actor,
    source?: EventSource,
    options?: MutationOptions,
  ): Promise<MutationResult>;
  review(
    id: number,
    actor: Actor,
    source?: EventSource,
    options?: MutationOptions,
  ): Promise<MutationResult>;
  done(
    id: number,
    actor: Actor,
    source?: EventSource,
    options?: MutationOptions,
  ): Promise<MutationResult>;
  reopen(
    id: number,
    actor: Actor,
    source?: EventSource,
    options?: MutationOptions,
  ): Promise<MutationResult>;
  move(
    id: number,
    to: CardState,
    actor: Actor,
    source?: EventSource,
    options?: MutationOptions,
  ): Promise<MutationResult>;
  remove(
    id: number,
    actor: Actor,
    source?: EventSource,
  ): Promise<MutationResult>;
  block(
    id: number,
    blockedById: number,
    actor: Actor,
    source?: EventSource,
  ): Promise<MutationResult>;
  unblock(
    id: number,
    blockedById: number,
    actor: Actor,
    source?: EventSource,
  ): Promise<MutationResult>;
  parent(
    id: number,
    parentId: number,
    actor: Actor,
    source?: EventSource,
    options?: MutationOptions,
  ): Promise<MutationResult>;
  unparent(
    id: number,
    actor: Actor,
    source?: EventSource,
    options?: MutationOptions,
  ): Promise<MutationResult>;
  relate(
    id: number,
    otherId: number,
    direction: RelationDirection,
    actor: Actor,
    source?: EventSource,
  ): Promise<MutationResult>;
  unrelate(
    id: number,
    otherId: number,
    actor: Actor,
    source?: EventSource,
  ): Promise<MutationResult>;
  addNote(
    id: number,
    input: AddNoteInput,
    actor: Actor,
    source?: EventSource,
  ): Promise<MutationResult>;
  updateNote(
    id: number,
    noteId: number,
    input: UpdateNoteInput,
    actor: Actor,
    source?: EventSource,
    options?: MutationOptions,
  ): Promise<MutationResult>;
  removeNote(
    id: number,
    noteId: number,
    actor: Actor,
    source?: EventSource,
  ): Promise<MutationResult>;
  close(): void;
}

/** The local store behind the same interface. One line per method, no logic. */
export class LocalBoardService implements BoardService {
  constructor(private readonly kanban: Kanban) {}

  async board(
    project?: string | null,
    subproject?: string | null,
  ): Promise<Board> {
    return this.kanban.board(project, subproject);
  }

  async cards(): Promise<Card[]> {
    return this.kanban.cards();
  }

  async card(id: number): Promise<Card | null> {
    return this.kanban.card(id);
  }

  async history(id: number): Promise<Event[]> {
    return this.kanban.history(id);
  }

  async mine(
    assignee: string,
    project?: string | null,
    subproject?: string | null,
  ): Promise<Card[]> {
    return this.kanban.mine(assignee, project, subproject);
  }

  async reviewQueue(
    reviewer: string,
    project?: string | null,
    subproject?: string | null,
  ): Promise<Card[]> {
    return this.kanban.reviewQueue(reviewer, project, subproject);
  }

  async childrenOf(id: number): Promise<Card[]> {
    return this.kanban.childrenOf(id);
  }

  async projects(): Promise<string[]> {
    return this.kanban.projects();
  }

  async projectSummary(): Promise<ProjectSummary[]> {
    return this.kanban.projectSummary();
  }

  async add(
    input: AddCardInput,
    actor: Actor,
    source: EventSource = "cli",
  ): Promise<MutationResult> {
    return this.kanban.add(input, actor, source);
  }

  async edit(
    id: number,
    input: EditCardInput,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): Promise<MutationResult> {
    return this.kanban.edit(id, input, actor, source, options);
  }

  async claim(
    id: number,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): Promise<MutationResult> {
    return this.kanban.claim(id, actor, source, options);
  }

  async review(
    id: number,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): Promise<MutationResult> {
    return this.kanban.review(id, actor, source, options);
  }

  async done(
    id: number,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): Promise<MutationResult> {
    return this.kanban.done(id, actor, source, options);
  }

  async reopen(
    id: number,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): Promise<MutationResult> {
    return this.kanban.reopen(id, actor, source, options);
  }

  async move(
    id: number,
    to: CardState,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): Promise<MutationResult> {
    return this.kanban.move(id, to, actor, source, options);
  }

  async remove(
    id: number,
    actor: Actor,
    source: EventSource = "cli",
  ): Promise<MutationResult> {
    return this.kanban.remove(id, actor, source);
  }

  async block(
    id: number,
    blockedById: number,
    actor: Actor,
    source: EventSource = "cli",
  ): Promise<MutationResult> {
    return this.kanban.block(id, blockedById, actor, source);
  }

  async unblock(
    id: number,
    blockedById: number,
    actor: Actor,
    source: EventSource = "cli",
  ): Promise<MutationResult> {
    return this.kanban.unblock(id, blockedById, actor, source);
  }

  async parent(
    id: number,
    parentId: number,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): Promise<MutationResult> {
    return this.kanban.parent(id, parentId, actor, source, options);
  }

  async unparent(
    id: number,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): Promise<MutationResult> {
    return this.kanban.unparent(id, actor, source, options);
  }

  async relate(
    id: number,
    otherId: number,
    direction: RelationDirection,
    actor: Actor,
    source: EventSource = "cli",
  ): Promise<MutationResult> {
    return this.kanban.relate(id, otherId, direction, actor, source);
  }

  async unrelate(
    id: number,
    otherId: number,
    actor: Actor,
    source: EventSource = "cli",
  ): Promise<MutationResult> {
    return this.kanban.unrelate(id, otherId, actor, source);
  }

  async addNote(
    id: number,
    input: AddNoteInput,
    actor: Actor,
    source: EventSource = "cli",
  ): Promise<MutationResult> {
    return this.kanban.addNote(id, input, actor, source);
  }

  async updateNote(
    id: number,
    noteId: number,
    input: UpdateNoteInput,
    actor: Actor,
    source: EventSource = "cli",
    options?: MutationOptions,
  ): Promise<MutationResult> {
    return this.kanban.updateNote(id, noteId, input, actor, source, options);
  }

  async removeNote(
    id: number,
    noteId: number,
    actor: Actor,
    source: EventSource = "cli",
  ): Promise<MutationResult> {
    return this.kanban.removeNote(id, noteId, actor, source);
  }

  close(): void {
    this.kanban.close();
  }
}
