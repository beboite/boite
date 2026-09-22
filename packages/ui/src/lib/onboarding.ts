/*
 * The tour that opens once, the first time Boite runs on a device.
 *
 * What it remembers lives in `localStorage` beside the theme and the
 * experiments, never in the core: the tour teaches the screen in front of you,
 * and a phone paired to the same core has its own first launch and its own
 * screens. `lib/experiments.ts` is the model, storage refused included: a
 * browser that answers nothing shows the tour and forgets it, which is the
 * right failure.
 *
 * The record carries the version of the tour that was seen. Nothing re-opens
 * on an upgrade today, and the number is what a later build would read to
 * decide otherwise, rather than a boolean that could not.
 */

export const ONBOARDING_STORAGE_KEY = 'boite.onboarding';

/** Bumped when the tour changes shape, not when a sentence in it is reworded. */
export const ONBOARDING_VERSION = 5;

export interface OnboardingRecord {
  version: number;
  /** When the tour was last closed, skipped or finished alike. */
  at: number;
}

export type OnboardingStep = 'welcome' | 'profile' | 'agents' | 'usage' | 'reach' | 'quiet' | 'privacy';

/**
 * The order they come in: what you talk to, who you are (the answer sets how
 * much the app shows), then how you talk to it, then what sits beside the
 * conversation, what it costs, how far it reaches, how it
 * behaves while you work, and finally the folder it all happens in.
 */
const ORDER: readonly OnboardingStep[] = ['welcome', 'profile', 'agents', 'usage', 'reach', 'quiet', 'privacy'];

/** The screens this build shows, in order. A fresh array: the caller owns it. */
export function steps(owner = true): OnboardingStep[] {
  return ORDER.filter(step => step !== 'privacy' || owner);
}

/** What the device remembers, or null when the tour has never been closed here. */
export function readOnboarding(): OnboardingRecord | null {
  try {
    const raw = window.localStorage.getItem(ONBOARDING_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Partial<OnboardingRecord>;
    if (typeof record.version !== 'number' || !Number.isFinite(record.version)) return null;
    return { version: record.version, at: typeof record.at === 'number' ? record.at : 0 };
  } catch {
    return null;
  }
}

/** Closing the tour writes this, whether it was finished or skipped at the first screen. */
export function writeOnboarding(now = Date.now()): void {
  try {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ version: ONBOARDING_VERSION, at: now }));
  } catch {
    /* a browser that refuses storage sees the tour again, which is no worse than nothing */
  }
}

/** Whether this device has already been through it. */
export function onboardingSeen(): boolean {
  return readOnboarding() !== null;
}
