import { SvelteMap } from 'svelte/reactivity';

export const QUOTA_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'dock'] as const;
export type QuotaPosition = typeof QUOTA_POSITIONS[number];
export const PINNED_QUOTAS_STORAGE = 'boite.pinned-quotas.v1';
export const PINNED_QUOTA_WIDTH = 280;

function restored(): { pinned: boolean; position: QuotaPosition } {
  try {
    const value = JSON.parse(localStorage.getItem(PINNED_QUOTAS_STORAGE) ?? 'null');
    return { pinned: value?.pinned === true, position: QUOTA_POSITIONS.includes(value?.position) ? value.position : 'bottom-left' };
  } catch { return { pinned: false, position: 'bottom-left' }; }
}

/** A device preference, shared by the chat and its rail across machine switches. */
class PinnedQuotas {
  current = $state(restored());
  /** Measured per conversation; automatic docking never overwrites the saved corner. */
  readonly crowded = new SvelteMap<object, boolean>();

  wantsDock(store: object): boolean {
    return this.current.position === 'dock' || this.crowded.get(store) === true;
  }

  set(pinned: boolean, position = this.current.position): void {
    this.current = { pinned, position };
    try { localStorage.setItem(PINNED_QUOTAS_STORAGE, JSON.stringify(this.current)); }
    catch { /* Keep the pick for this session when storage is unavailable. */ }
  }
}

export const pinnedQuotas = new PinnedQuotas();
