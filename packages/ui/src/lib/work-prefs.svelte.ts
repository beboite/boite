/*
 * How this device starts work: which composer options stay in the bar, where
 * a new conversation goes, and what an empty side panel opens on.
 *
 * The tour's question, developer or not, writes all of it at once. It is a
 * preset, not a mode: nothing reads the answer itself, only these settings,
 * and each one changes on its own afterwards (the Options menu's pins, the
 * Appearance page). Stored per device beside the other local preferences,
 * since a phone paired to the same core has its own screen and its own habits.
 */

export type Profile = 'everyday' | 'developer';
/** The composer options a pin can keep in the bar. The permission mode is never hidden. */
export type PinId = 'effort' | 'worktree';
/** Where the app opens: the drafts folder, or the last project. New thread always follows the project on screen. */
export type StartIn = 'drafts' | 'project';
/** What an empty side panel opens on: its launcher, or one surface directly. */
export type PanelStart = 'launcher' | 'files' | 'changes';

export interface WorkPrefs {
  /** The last answer to the tour's question, kept only so the tour can show it. */
  profile: Profile | null;
  pins: Record<PinId, boolean>;
  startIn: StartIn;
  panel: PanelStart;
}

export const WORK_STORAGE_KEY = 'boite.work';

const PINS: readonly PinId[] = ['effort', 'worktree'];
const STARTS: readonly StartIn[] = ['drafts', 'project'];
const PANELS: readonly PanelStart[] = ['launcher', 'files', 'changes'];

/** What each answer writes. */
export const PRESETS: Record<Profile, Omit<WorkPrefs, 'profile'>> = {
  everyday: { pins: { effort: false, worktree: false }, startIn: 'drafts', panel: 'files' },
  developer: { pins: { effort: true, worktree: true }, startIn: 'project', panel: 'changes' }
};

/** A device that has not answered yet: the calm bar, the drafts first. */
export function freshWork(): WorkPrefs {
  return { profile: null, ...PRESETS.everyday, pins: { ...PRESETS.everyday.pins } };
}

/** An install that predates the question keeps every chip where it was, and the panel's launcher. */
export function migratedWork(): WorkPrefs {
  return { profile: null, pins: { effort: true, worktree: true }, startIn: 'project', panel: 'launcher' };
}

/** A stored record, or null when it is missing or does not read like one. */
export function parseWork(raw: string | null): WorkPrefs | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Partial<WorkPrefs>;
    const pins = typeof record.pins === 'object' && record.pins !== null ? record.pins : null;
    if (!pins) return null;
    return {
      profile: record.profile === 'everyday' || record.profile === 'developer' ? record.profile : null,
      pins: Object.fromEntries(PINS.map((id) => [id, pins[id] === true])) as Record<PinId, boolean>,
      startIn: STARTS.includes(record.startIn as StartIn) ? (record.startIn as StartIn) : 'project',
      panel: PANELS.includes(record.panel as PanelStart) ? (record.panel as PanelStart) : 'launcher'
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
    this.#write({ profile, pins: { ...preset.pins }, startIn: preset.startIn, panel: preset.panel });
  }

  pin(id: PinId, on: boolean): void {
    if (this.current.pins[id] === on) return;
    this.#write({ ...this.current, pins: { ...this.current.pins, [id]: on } });
  }

  setStartIn(startIn: StartIn): void {
    if (this.current.startIn !== startIn) this.#write({ ...this.current, startIn });
  }

  setPanel(panel: PanelStart): void {
    if (this.current.panel !== panel) this.#write({ ...this.current, panel });
  }
}

export const work = new Work();
