import type { Event, Kanban } from "@wayblink/using-kanban-core";

/**
 * Tails the event log and fans events out to connected SSE clients.
 *
 * Polling (rather than a pub/sub inside one process) is deliberate: events
 * appended by *other* processes — the CLI, an MCP server — reach the browser
 * too, which is the whole point of a shared board.
 */
export class EventBroker {
  private readonly listeners = new Set<(event: Event) => void>();
  private timer: NodeJS.Timeout | null = null;
  private cursor = 0;

  constructor(
    private readonly kanban: Kanban,
    private readonly pollMs: number,
  ) {
    this.cursor = lastEventId(kanban);
  }

  subscribe(listener: (event: Event) => void): () => void {
    this.listeners.add(listener);
    this.start();
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref();
  }

  private poll(): void {
    let events: Event[];
    try {
      events = this.kanban.eventsSince(this.cursor);
    } catch {
      return;
    }
    for (const event of events) {
      this.cursor = event.id;
      for (const listener of [...this.listeners]) {
        listener(event);
      }
    }
  }
}

function lastEventId(kanban: Kanban): number {
  const events = kanban.events();
  return events.at(-1)?.id ?? 0;
}
