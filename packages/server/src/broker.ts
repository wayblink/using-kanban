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

  private readonly ready: Promise<void>;
  private polling = false;

  constructor(
    private readonly kanban: Kanban,
    private readonly pollMs: number,
  ) {
    // The cursor starts at the log's current end, so a new subscriber sees
    // what happens next — not a replay of the whole board.
    this.ready = this.initCursor();
  }

  private async initCursor(): Promise<void> {
    try {
      const events = await this.kanban.events();
      this.cursor = events.at(-1)?.id ?? 0;
    } catch {
      // A broker that cannot read yet keeps cursor 0; the first successful poll
      // re-reads from the beginning, which is the honest fallback.
    }
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
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollMs);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.ready;
      const events = await this.kanban.eventsSince(this.cursor);
      for (const event of events) {
        this.cursor = event.id;
        for (const listener of [...this.listeners]) {
          listener(event);
        }
      }
    } catch {
      // Transient read failures are retried on the next tick; the cursor has
      // not moved, so nothing is lost.
    } finally {
      this.polling = false;
    }
  }
}
