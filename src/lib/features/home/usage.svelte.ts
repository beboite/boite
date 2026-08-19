import { backend } from "$lib/backend";
import type { UsageReport } from "$lib/backend/types";
import { USAGE_DAYS } from "$lib/features/project/usage.svelte";

/**
 * What every project's agents have spent, read once for the home calendar.
 *
 * Same bargain as `projectUsage`: a scan walks transcripts, so the heatmap and
 * the headline figure share one answer. Nothing polls. The card carries the
 * refresh for when the number has moved.
 */

const EMPTY: UsageReport = { models: [], days: [], sessions: 0, missing: [] };

const STALE_MS = 120_000;

class WorkspaceUsageStore {
  #report = $state<UsageReport | null>(null);
  #loading = $state(false);
  #readAt = 0;

  report(): UsageReport | null {
    return this.#report;
  }

  loading(): boolean {
    return this.#loading;
  }

  async load(cwds: string[]) {
    if (this.#loading) return;
    this.#loading = true;
    this.#readAt = Date.now();
    try {
      if (cwds.length === 0) {
        this.#report = EMPTY;
        return;
      }
      this.#report = await backend().session.usage(cwds, USAGE_DAYS);
    } catch {
      this.#report = { ...EMPTY, unreachable: true };
    } finally {
      this.#loading = false;
    }
  }

  ensure(cwds: string[]) {
    if (this.#report && Date.now() - this.#readAt < STALE_MS) return;
    void this.load(cwds);
  }
}

export const workspaceUsage = new WorkspaceUsageStore();
