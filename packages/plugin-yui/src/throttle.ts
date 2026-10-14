const WINDOW_MS = 60_000;

/** Per-room limiter: at most `limit` posts per room in any rolling 60s window. */
export class Throttle {
  private timestamps = new Map<string, number[]>();

  constructor(private readonly limit: number) {}

  canPost(room: string, now = Date.now()): boolean {
    return this.recent(room, now).length < this.limit;
  }

  /**
   * Reserves a slot before any network call, so concurrent posts can't both pass the check.
   * Returns a function that gives the slot back (for posts the server definitely refused),
   * or null when the room is at its cap.
   */
  tryAcquire(room: string, now = Date.now()): (() => void) | null {
    const recent = this.recent(room, now);
    if (recent.length >= this.limit) {
      return null;
    }
    recent.push(now);
    this.timestamps.set(room, recent);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const list = this.timestamps.get(room);
      const index = list?.lastIndexOf(now) ?? -1;
      if (list && index >= 0) list.splice(index, 1);
    };
  }

  private recent(room: string, now: number): number[] {
    const cutoff = now - WINDOW_MS;
    return (this.timestamps.get(room) || []).filter((t) => t > cutoff);
  }
}
