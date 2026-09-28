/*
 * How this device starts work: where a new conversation goes, what an empty
 * side panel opens on, and whether the developer tools show.
 *
 * The tour's question, developer or not, writes all of it at once. It is a
 * preset, not a mode: nothing reads the answer itself, only these settings,
 * and each one changes on its own afterwards (the Appearance page, the
 * developer tools switch in General). Stored per device beside the other local preferences,
 * since a phone paired to the same core has its own screen and its own habits.
 */

export type Profile = 'everyday' | 'developer';
/** Where the app opens: the drafts folder, or the last project. New thread always follows the project on screen. */
export type StartIn = 'drafts' | 'project';
/** What an empty side panel opens on: its launcher, or one surface directly. */
export type PanelStart = 'launcher' | 'files' | 'changes';

export interface WorkPrefs {
  /** The last answer to the tour's question, kept only so the tour can show it. */
  profile: Profile | null;
  startIn: StartIn;
  panel: PanelStart;
  /** The terminal and the process trace: tools a developer reaches for and nobody else needs to see. */
  developer: boolean;
}

export const WORK_STORAGE_KEY = 'boite.work';

const STARTS: readonly StartIn[] = ['drafts', 'project'];
const PANELS: readonly PanelStart[] = ['launcher', 'files', 'changes'];

/** What each answer writes. */
export const PRESETS: Record<Profile, Omit<WorkPrefs, 'profile'>> = {
  everyday: { startIn: 'drafts', panel: 'files', developer: false },
  developer: { startIn: 'project', panel: 'changes', developer: true }
};

/** A device that has not answered yet: the drafts first. */
export function freshWork(): WorkPrefs {
  return { profile: null, ...PRESETS.everyday };
}

/** An install that predates the question keeps opening on its project, the panel's launcher and its tools. */
export function migratedWork(): WorkPrefs {
  return { profile: null, startIn: 'project', panel: 'launcher', developer: true };
}

/** A stored record, or null when it is missing or does not read like one. */
export function parseWork(raw: string | null): WorkPrefs | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Partial<WorkPrefs>;
    return {
      profile: record.profile === 'everyday' || record.profile === 'developer' ? record.profile : null,
      startIn: STARTS.includes(record.startIn as StartIn) ? (record.startIn as StartIn) : 'project',
      panel: PANELS.includes(record.panel as PanelStart) ? (record.panel as PanelStart) : 'launcher',
      // A record from before the switch keeps what its answer meant; no answer was a working setup.
      developer: typeof record.developer === 'boolean' ? record.developer : record.profile !== 'everyday'
    };
  } catch {
    return null;
  }
}

function readStored(): WorkPrefs | null {
  try {
    return parseWork(window.localStorage.getItem(WORK_STORAGE_KEY));
  } catch {
    return null;
  }
}

class Work {
  current = $state<WorkPrefs>(freshWork());
  /** Whether this device holds a record: until it does, `settle` decides which one it starts with. */
  #stored = false;

  constructor() {
    this.load();
  }

  load(): void {
    const stored = readStored();
    this.#stored = stored !== null;
    this.current = stored ?? freshWork();
  }

  #write(next: WorkPrefs): void {
    this.current = next;
    this.#stored = true;
    try {
      window.localStorage.setItem(WORK_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* a browser that refuses storage keeps the choice for this session */
    }
  }

  /**
   * The first time a core answers on this device with no record here: an
   * install that already has conversations, or has already seen the tour, is
   * someone's working setup and keeps everything in view. Anything else is a
   * first run and starts calm.
   */
  settle(existing: boolean): void {
    if (this.#stored) return;
    this.#write(existing ? migratedWork() : freshWork());
  }

  choose(profile: Profile): void {
    const preset = PRESETS[profile];
    this.#write({ profile, startIn: preset.startIn, panel: preset.panel, developer: preset.developer });
  }

  setStartIn(startIn: StartIn): void {
    if (this.current.startIn !== startIn) this.#write({ ...this.current, startIn });
  }

  setDeveloper(developer: boolean): void {
    if (this.current.developer !== developer) this.#write({ ...this.current, developer });
  }

  setPanel(panel: PanelStart): void {
    if (this.current.panel !== panel) this.#write({ ...this.current, panel });
  }
}

export const work = new Work();
