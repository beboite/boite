/** A foreground command and the idle heartbeat share one native connection. */
export class LunaCommandGate {
  private foregroundBusy = false;
  private pendingHeartbeat: Promise<unknown> | undefined;
  async command<T>(run: () => Promise<T>): Promise<T> {
    if (this.foregroundBusy) throw new Error('Concurrent browser command rejected.');
    // Reserve the foreground slot before waiting so no new idle task can win
    // the connection between the heartbeat completing and this continuation.
    this.foregroundBusy = true;
    try { await this.pendingHeartbeat?.catch(() => {}); return await run(); }
    finally { this.foregroundBusy = false; }
  }
  async heartbeat(run: () => Promise<unknown>): Promise<boolean> {
    if (this.foregroundBusy || this.pendingHeartbeat) return false;
    this.pendingHeartbeat = Promise.resolve().then(run);
    try { await this.pendingHeartbeat; return true; }
    finally { this.pendingHeartbeat = undefined; }
  }
}
