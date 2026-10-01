/*
 * How this device starts work: where a new conversation goes, what an empty
 * side panel opens on, and which of the optional buttons it shows.
 *
 * The tour's question, developer or not, writes all of it at once. It is a
 * preset, not a mode: nothing reads the answer itself, only these settings,
 * and each one changes on its own afterwards (the Appearance page, or a
 * button's own right click). Stored per device beside the other local preferences,
 * since a phone paired to the same core has its own screen and its own habits.
 */

export type Profile = 'everyday' | 'developer';
/** Where the app opens: the drafts folder, or the last project. New thread always follows the project on screen. */
export type StartIn = 'drafts' | 'project';
/** What an empty side panel opens on: its launcher, or one surface directly. */
export type PanelStart = 'launcher' | 'files' | 'changes';

/**
 * Every button a device may put away. Hiding one takes the button off the
 * screen and nothing else: the palette and the shortcuts still reach what it
 * opened, and whatever is open stays open.
 */
export const CONTROL_IDS = [
  'header.project',
  'header.branch',
  'header.context',
  'header.terminal',
  'sidebar.limits',
  'sidebar.add-project',
  'panel.agents',
  'panel.browser',
  'panel.changes',
  'panel.files',
  'panel.tasks',
  'panel.trace'
] as const;
export type ControlId = (typeof CONTROL_IDS)[number];

export interface WorkPrefs {
  /** The last answer to the tour's question, kept only so the tour can show it. */
  profile: Profile | null;
  startIn: StartIn;
  panel: PanelStart;
  /** The buttons this device put away, in `CONTROL_IDS` order. A button added later shows until someone hides it. */
  hidden: ControlId[];
}

export const WORK_STORAGE_KEY = 'boite.work';

const STARTS: readonly StartIn[] = ['drafts', 'project'];
const PANELS: readonly PanelStart[] = ['launcher', 'files', 'changes'];

/** The terminal and the process trace: tools a developer reaches for and nobody else needs to see. */
const DEVELOPER_CONTROLS: readonly ControlId[] = ['header.terminal', 'panel.trace'];

/** What each answer writes. */
export const PRESETS: Record<Profile, Omit<WorkPrefs, 'profile'>> = {
  everyday: { startIn: 'drafts', panel: 'files', hidden: [...DEVELOPER_CONTROLS] },
  developer: { startIn: 'project', panel: 'changes', hidden: [] }
};

/** A device that has not answered yet: the drafts first. */
export function freshWork(): WorkPrefs {
  return { profile: null, ...PRESETS.everyday, hidden: [...PRESETS.everyday.hidden] };
}

/** An install that predates the question keeps opening on its project, the panel's launcher and every button. */
export function migratedWork(): WorkPrefs {
  return { profile: null, startIn: 'project', panel: 'launcher', hidden: [] };
}

/** Known ids only, each once, in the catalogue's order. */
function cleanHidden(ids: readonly unknown[]): ControlId[] {
  return CONTROL_IDS.filter((id) => ids.includes(id));
}

/** A stored record, or null when it is missing or does not read like one. */
export function parseWork(raw: string | null): WorkPrefs | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Partial<WorkPrefs> & { developer?: unknown };
    // A record from before the list had one switch for the developer's tools;
    // before that, only the answer, and no answer was a working setup.
    const developer = typeof record.developer === 'boolean' ? record.developer : record.profile !== 'everyday';
    return {
      profile: record.profile === 'everyday' || record.profile === 'developer' ? record.profile : null,
      startIn: STARTS.includes(record.startIn as StartIn) ? (record.startIn as StartIn) : 'project',
      panel: PANELS.includes(record.panel as PanelStart) ? (record.panel as PanelStart) : 'launcher',
      hidden: Array.isArray(record.hidden) ? cleanHidden(record.hidden) : developer ? [] : [...DEVELOPER_CONTROLS]
    };
  } catch {
    return null;
  }
}

/** The preset whose buttons match these exactly, or null for a device that picked its own. */
export function matchingPreset(hidden: readonly ControlId[]): Profile | null {
  const same = (preset: readonly ControlId[]) => preset.length === hidden.length && preset.every((id) => hidden.includes(id));
  if (same(PRESETS.developer.hidden)) return 'developer';
  if (same(PRESETS.everyday.hidden)) return 'everyday';
  return null;
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
    this.#write({ profile, startIn: preset.startIn, panel: preset.panel, hidden: [...preset.hidden] });
  }

  setStartIn(startIn: StartIn): void {
    if (this.current.startIn !== startIn) this.#write({ ...this.current, startIn });
  }

  setPanel(panel: PanelStart): void {
    if (this.current.panel !== panel) this.#write({ ...this.current, panel });
  }

  /** Whether this device shows a button. */
  shows(id: ControlId): boolean {
    return !this.current.hidden.includes(id);
  }

  show(id: ControlId, on: boolean): void {
    if (this.shows(id) === on) return;
    const hidden = on ? this.current.hidden.filter((one) => one !== id) : cleanHidden([...this.current.hidden, id]);
    this.#write({ ...this.current, hidden });
  }

  /** One preset's buttons, the rest of the record untouched. */
  showPreset(profile: Profile): void {
    this.#write({ ...this.current, hidden: [...PRESETS[profile].hidden] });
  }
}

export const work = new Work();
