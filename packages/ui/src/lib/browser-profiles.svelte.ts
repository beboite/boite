/**
 * The browser profiles of this desktop. Each is a WebView2 profile the shell
 * opens (`src/browser.rs`), so they belong to the computer showing the browser,
 * and they are kept in the settings of the core this shell started. App.svelte
 * points `source` at that core's Store, or at the active one when there is no
 * local core (`?fake=1`, a plain browser).
 */
import {
  browserProfilesOf,
  DEFAULT_BROWSER_PROFILE,
  findBrowserProfile,
  PRIVATE_BROWSER_PROFILE,
  type BrowserProfile,
  type Settings
} from '@boite/contracts';
import { secureId } from './secure-id';
import { strings } from './strings';

export interface ProfileSource {
  readonly settings: Settings | null;
  saveSettings(patch: Partial<Settings>): Promise<boolean>;
}

class BrowserProfiles {
  source = $state.raw<ProfileSource | null>(null);

  #of = $derived(browserProfilesOf(this.source?.settings));

  /** The profiles the user made, without the built-in default and private ones. */
  get list(): BrowserProfile[] {
    return this.#of.profiles;
  }

  /** The profile a tab opens in when nobody chose one. */
  get defaultId(): string {
    return this.#of.defaultId;
  }

  /** What a tab's profile reads as. An id no longer listed reads as itself. */
  name(id: string | undefined): string {
    if (id === undefined || id === DEFAULT_BROWSER_PROFILE) return strings.browserProfiles.default;
    if (id === PRIVATE_BROWSER_PROFILE) return strings.browserProfiles.private;
    return this.list.find((profile) => profile.id === id)?.name ?? id;
  }

  /** A name, an id, `default` or `private`, as an agent names it. */
  find(wanted: string): string | null {
    return findBrowserProfile(this.list, wanted);
  }

  /** Saves the whole list with its default, which falls back to `default` once its profile is gone. */
  save(profiles: BrowserProfile[], defaultId = this.defaultId): Promise<boolean> {
    const source = this.source;
    if (!source) return Promise.resolve(false);
    const kept = profiles.some((profile) => profile.id === defaultId) ? defaultId : DEFAULT_BROWSER_PROFILE;
    return source.saveSettings({ browserProfiles: profiles, browserDefaultProfile: kept });
  }
}

export const browserProfiles = new BrowserProfiles();

/**
 * A new profile's id names its folder for good: WebView2 removes a deleted
 * profile's folder only when the browser process exits, so an id is never
 * derived from a name that could come back.
 */
export function newProfileId(): string {
  return `p-${secureId().slice(0, 12)}`;
}
