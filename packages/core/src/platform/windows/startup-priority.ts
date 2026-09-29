/** Retains failed native downgrades until Windows accepts the background priority. */
export class StartupPriority {
  private active = false;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly write: (active: boolean) => boolean, private readonly retryMs = 250) {}

  set(active: boolean): void {
    this.active = active;
    this.apply();
  }

  apply(): void {
    this.close();
    if (this.write(this.active)) return;
    if (this.active) {
      this.active = false;
      if (this.write(false)) return;
    }
    this.retry = setTimeout(() => { this.retry = null; this.apply(); }, this.retryMs);
    this.retry.unref?.();
  }

  close(): void {
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
  }
}
