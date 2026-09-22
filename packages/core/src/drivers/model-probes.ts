import type { AccountId, ModelInfo, ProviderId } from '@boite/contracts';
import type { ProbeContext, ProbeFilter, ProbeResult } from './types.ts';

interface Entry {
  providerId: ProviderId;
  accountId: AccountId;
  running: Promise<ProbeResult> | null;
  result: ProbeResult | null;
}

/** Coalesces model reads without letting an invalidated read repopulate the cache. */
export class ModelProbes {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly read: (context: ProbeContext) => Promise<ModelInfo[]>) {}

  async probe(context: ProbeContext): Promise<ProbeResult> {
    const key = this.key(context.provider.id, context.accountId);
    const entry = this.entries.get(key) ?? {
      providerId: context.provider.id, accountId: context.accountId, running: null, result: null,
    };
    this.entries.set(key, entry);
    if (entry.result !== null) return entry.result;
    if (entry.running !== null) return entry.running;

    // Start in a microtask so synchronous reader failures follow the same cleanup path.
    const running = Promise.resolve().then(() => this.read(context))
      .then(models => ({ models, probedAt: Date.now() }));
    entry.running = running;
    try {
      const result = await running;
      if (this.entries.get(key) === entry) entry.result = result;
      return result;
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    } finally {
      entry.running = null;
    }
  }

  models(providerId: ProviderId, accountId: AccountId): ModelInfo[] | null {
    return this.entries.get(this.key(providerId, accountId))?.result?.models ?? null;
  }

  forget(filter: ProbeFilter = {}): void {
    for (const [key, entry] of this.entries) {
      if (filter.providerId !== undefined && filter.providerId !== entry.providerId) continue;
      if (filter.accountId !== undefined && filter.accountId !== entry.accountId) continue;
      this.entries.delete(key);
    }
  }

  private key(providerId: ProviderId, accountId: AccountId): string {
    return JSON.stringify([providerId, accountId]);
  }
}
