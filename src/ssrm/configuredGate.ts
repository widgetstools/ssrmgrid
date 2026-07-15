/**
 * Replaces busy-wait polls for "configure + initial setRowData finished".
 * Datasource getRows / set-filter value loads await this instead of spinning.
 */
export class ConfiguredGate {
  private ready = false;
  private readonly waiters = new Set<{
    resolve: (ok: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  get isReady(): boolean {
    return this.ready;
  }

  /** Call when configure starts or the client is disposed. */
  reset(): void {
    this.ready = false;
  }

  /** Call once configure + initial snapshot succeed. */
  markReady(): void {
    this.ready = true;
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve(true);
    }
    this.waiters.clear();
  }

  /**
   * Resolves true when ready, false on timeout.
   * Immediate true if already ready.
   */
  wait(timeoutMs = 10_000): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const entry = {
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(entry);
          resolve(false);
        }, timeoutMs),
      };
      this.waiters.add(entry);
    });
  }
}
