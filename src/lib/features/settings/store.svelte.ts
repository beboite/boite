import { backend } from "$lib/backend";
import { loadSettings, saveSettings } from "$lib/storage/db";
import { notifications } from "$lib/features/notifications/store.svelte";
import { isLocaleSetting, setLocale as applyLocale, t } from "$lib/i18n/index.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { debounce } from "$lib/shared/utils/debounce";
import { clampTerminalScale } from "$lib/theme/fonts";
import { uuid } from "$lib/shared/utils/uuid";
import { isThemeId } from "$lib/theme/themes";
import type {
  InfoBoxAnchor,
  Keybinding,
  LocaleSetting,
  OpenOnLaunch,
  RightPanelTab,
  Settings,
  Shortcut,
  SidebarDesign,
  SmartSortBy,
  SortDirection,
  WhipSound,
} from "$lib/types";
import { isInfoBoxAnchor } from "$lib/features/infobox/anchor";
import { DEFAULT_KEYBINDINGS } from "$lib/shared/keyboard/defaults";
import {
  mergeDefaultKeybindings,
  sanitizeKeybindings,
} from "$lib/shared/keyboard/merge";
import {
  clampRightPanelWidth,
  isRightPanelTab,
  readRightPanelMap,
} from "./right-panel";
import { cliDetection } from "./cliDetection.svelte";
import { CLI_PRESETS, type CliPreset } from "./cliPresets";

// The shortcut list is the user's, and only the first run fills it: the setup
// wizard seeds whatever `cliDetection` finds on the machine, and everything
// after that is an add or a remove in Settings. A preset shipped later is
// offered in the shortcut editor, never pushed into an install that never
// asked for it — that backfill handed people agents whose binary they do not
// have.
function migrateShortcuts(raw: unknown): { shortcuts: Shortcut[]; changed: boolean } {
  if (!Array.isArray(raw)) {
    return { shortcuts: [], changed: false };
  }

  let changed = false;
  const filtered = raw.filter((shortcut): shortcut is Shortcut => {
    return (
      shortcut &&
      typeof shortcut === "object" &&
      "id" in shortcut &&
      "label" in shortcut &&
      "command" in shortcut &&
      typeof shortcut.id === "string" &&
      typeof shortcut.label === "string" &&
      typeof shortcut.command === "string"
    );
  });

  const withoutGemini = filtered.filter((shortcut) => {
    const drop =
      shortcut.iconKey === ("gemini" as unknown as Shortcut["iconKey"]) ||
      shortcut.id === "gemini" ||
      /^gemini(\s|$)/i.test(shortcut.command.trim());
    if (drop) changed = true;
    return !drop;
  });

  const shortcuts = withoutGemini.map((shortcut) => {
    if (
      shortcut.iconKey === "codex" &&
      shortcut.command.trim() === "codex"
    ) {
      changed = true;
      return { ...shortcut, command: "codex --no-alt-screen" };
    }
    return shortcut;
  });

  return { shortcuts, changed };
}

/** The shortcut a preset becomes, with an id of its own so two rows can share a command. */
export function shortcutFromPreset(preset: CliPreset): Shortcut {
  return {
    id: uuid(),
    label: preset.label,
    command: preset.command,
    iconKey: preset.iconKey,
  };
}

/** Every preset whose executable the active backend just answered for. */
async function detectedShortcuts(): Promise<Shortcut[]> {
  await cliDetection.refreshAll();
  return CLI_PRESETS.filter((preset) => cliDetection.found[preset.executable]).map(
    shortcutFromPreset,
  );
}

// Handing a terse note straight to an agent wastes the first turn on it asking
// what you meant. The scaffold spends that turn up front, and carries the id so
// the agent can report back through the MCP endpoint instead of you relaying it.
export const DEFAULT_TODO_PROMPT = `Task from my Boite todo list (id {{id}}):

{{task}}

Before changing anything: restate what you understand, name the files involved, and propose a plan. When it is done, call the boite MCP tool todo_claim with that id, a one-line summary of what changed, and the commit sha if you committed — leave it out rather than guessing, Boite reads it back from the repository.

You are working in your own detached worktree of this project, so nothing you do disturbs the other terminals. It is on no branch: if this turns into work worth keeping, call worktree_branch with a name that matches the repository's existing convention, or worktree_reserve to continue a branch that already exists. Do it once you know, not up front — a worktree nobody claimed is discarded when the thread closes, which is the right ending for a question you only answered.`;

const DEFAULTS: Settings = {
  // Empty on purpose: an install with no shortcuts has not run the wizard yet,
  // and the wizard fills this with what the machine actually has.
  shortcuts: [],
  keybindings: DEFAULT_KEYBINDINGS,
  powershellNewline: true,
  powershellNoProfile: false,
  threadWorktrees: true,
  defaultShellId: null,
  sidebarWidth: 240,
  sidebarCollapsed: false,
  uiScalePercent: 100,
  projectOrder: [],
  threadOrderByProject: {},
  todoPromptTemplate: DEFAULT_TODO_PROMPT,
  agentTodoAccess: true,
  mcpYolo: false,
  idleTimeoutMinutes: 10,
  idleAutocloseByIcon: {
    claude: true,
    codex: true,
    opencode: true,
    cursor: true,
    antigravity: true,
    copilot: true,
    grok: true,
    hermes: true,
    pi: true,
    muse: true,
  },
  confirmCloseThread: true,
  rightPanel: null,
  rightPanelByProject: {},
  rightPanelWidth: 320,
  gitSplitFraction: 0.5,
  gitAutoFetch: true,
  gitAutoFetchSeconds: 180,
  mobileLayout: false,
  layoutPinned: false,
  motionMode: "system",
  themeMode: "system",
  uiFontFamily: null,
  terminalFontFamily: null,
  terminalFontScalePercent: 100,
  locale: "system",
  setupCompleted: false,
  fastpickEnabled: true,
  colorByModel: true,
  sidebarDesign: "classic",
  sidebarHarnessLogos: true,
  experimentInfoBox: false,
  infoBoxAnchor: "top-right",
  infoBoxCollapsed: false,
  experimentSmartSort: false,
  experimentWhip: false,
  whipSound: "synth",
  smartSortBy: "manual",
  smartSortDirection: "desc",
  experimentHome: false,
  openOnLaunch: "last",
};

// First-run guess: touch-primary, narrow screens (a phone TWA/PWA) default to
// the mobile layout. The toggle in Appearance overrides it permanently after.
function isMotionMode(value: unknown): value is Settings["motionMode"] {
  return value === "system" || value === "on" || value === "off";
}

// Asked of the registry rather than spelled out, so a palette added there is
// not a palette this rejects on the next start and silently resets to system.
function isThemeMode(value: unknown): value is Settings["themeMode"] {
  return value === "system" || isThemeId(value);
}

// A family the machine no longer has is kept rather than dropped: the stack
// falls through to the shipped one on its own, and clearing the row would lose
// the choice for good the first time the app opened on a second machine.
function readFamily(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isSmartSortBy(value: unknown): value is SmartSortBy {
  return value === "manual" || value === "activity" || value === "alphabetical";
}

function isSortDirection(value: unknown): value is SortDirection {
  return value === "asc" || value === "desc";
}

function isWhipSound(value: unknown): value is WhipSound {
  return value === "synth" || value === "sampled" || value === "meme";
}

function isOpenOnLaunch(value: unknown): value is OpenOnLaunch {
  return value === "home" || value === "project" || value === "last";
}

/**
 * The sidebar design, from a row that may predate it.
 *
 * `sidebarThreadGlow` was the same choice spelled as a boolean, and a row
 * written while it was on means the user asked for the second design. Reading it
 * here rather than migrating the column keeps the fallback for a workspace that
 * never gets written again.
 */
function readSidebarDesign(stored: Record<string, unknown>): SidebarDesign {
  if (stored.sidebarDesign === "classic" || stored.sidebarDesign === "glow") {
    return stored.sidebarDesign;
  }
  return stored.sidebarThreadGlow === true ? "glow" : DEFAULTS.sidebarDesign;
}

// The column's own two rules live beside it, not in here: see right-panel.ts.
export {
  clampRightPanelWidth,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
} from "./right-panel";

const MOBILE_LAYOUT_QUERY = "(pointer: coarse) and (max-width: 899px)";

/**
 * Whether this device wants the mobile layout right now.
 *
 * One media query rather than a coarse-pointer check plus a JS width read: the
 * two could disagree, and only a query can be listened to. `watchFormFactor`
 * below is what keeps an unpinned layout honest when the window is resized or
 * the device is rotated.
 */
function detectMobileDefault(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia?.(MOBILE_LAYOUT_QUERY)?.matches ?? false;
  } catch {
    return false;
  }
}

export const GIT_AUTOFETCH_MIN_SECONDS = 30;
export const GIT_AUTOFETCH_MAX_SECONDS = 3600;

export function parseCommand(input: string): { cmd: string; args: string[] } {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of input.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return { cmd: tokens[0] ?? "", args: tokens.slice(1) };
}

// Device-scoped fields: per-machine, never stored in a workspace DB. They live
// in localStorage so switching to a remote workspace keeps your sidebar width
// and zoom while shortcuts/shells come from the server.
//
// The test is what the value describes, not where it was first stored. A field
// belongs here when it describes the glass the user is looking at: the geometry
// of this window, the motion this OS asked for, what this sidebar draws, what
// this client confirms before acting. It stays in the workspace blob when it
// describes the machine the threads run on (shells, launch flags, worktrees),
// what agents there are allowed to do, or how that workspace's own entities are
// named and ordered.
//
// The three sidebar cosmetics were on the wrong side of that line: toggling the
// thread glow on a phone repainted the desktop sitting next to it, because both
// were reading one row in the boite's database.
const DEVICE_KEY = "boite.layout";
const DEVICE_FIELDS = [
  "sidebarWidth",
  "sidebarCollapsed",
  "rightPanel",
  "rightPanelByProject",
  "rightPanelWidth",
  "uiScalePercent",
  "gitSplitFraction",
  "mobileLayout",
  "layoutPinned",
  "motionMode",
  "themeMode",
  "uiFontFamily",
  "terminalFontFamily",
  "terminalFontScalePercent",
  "locale",
  "colorByModel",
  "sidebarDesign",
  "sidebarHarnessLogos",
  "experimentInfoBox",
  "infoBoxAnchor",
  "infoBoxCollapsed",
  "experimentSmartSort",
  "experimentWhip",
  "whipSound",
  "smartSortBy",
  "smartSortDirection",
  "confirmCloseThread",
  "experimentHome",
  "openOnLaunch",
] as const;

// Stamped on the blob so an absent key can be told apart from a key that had
// not been promoted yet. Bump it whenever a field joins DEVICE_FIELDS, and list
// the newcomers in PROMOTED_TO_DEVICE so they migrate once.
const DEVICE_BLOB_VERSION = 2;

// Moved out of the workspace blob. A device blob whose `v` is missing or older
// than DEVICE_BLOB_VERSION has no key for the newcomers, and the workspace
// value is the right one-shot seed. Once the blob is at the current version, an
// absent key means the default and never the boite's value: falling through to
// the workspace blob is how `motionMode`, `locale` and `layoutPinned` used to
// leak in from the server on any device whose localStorage predated them
// joining the list.
const PROMOTED_TO_DEVICE: readonly string[] = [
  "colorByModel",
  "sidebarDesign",
  "sidebarHarnessLogos",
  "confirmCloseThread",
  "experimentHome",
  "openOnLaunch",
];

type DeviceBlob = Partial<Settings> & { v?: number };

function loadDeviceOverrides(): DeviceBlob | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    return raw ? (JSON.parse(raw) as DeviceBlob) : null;
  } catch {
    return null;
  }
}

/** Lays the device blob over a freshly hydrated state. */
function applyDeviceOverrides(state: Settings, dev: DeviceBlob): void {
  const target = state as unknown as Record<string, unknown>;
  const staleBlob = typeof dev.v !== "number" || dev.v < DEVICE_BLOB_VERSION;
  for (const k of DEVICE_FIELDS) {
    if (dev[k] !== undefined) {
      target[k] = dev[k];
      continue;
    }
    // Left alone on a stale blob: whatever is in `target` came from the
    // workspace and is the migration source for exactly one load.
    if (staleBlob && PROMOTED_TO_DEVICE.includes(k)) continue;
    target[k] = structuredClone(DEFAULTS[k]);
  }
  state.rightPanelByProject = readRightPanelMap(state.rightPanelByProject);
  // The stored width was chosen in whatever window was open at the time, and
  // this one may be smaller. Clamped on the way in rather than only in the
  // setter, which a boot never calls.
  state.rightPanelWidth = clampRightPanelWidth(state.rightPanelWidth);
  if (!isInfoBoxAnchor(state.infoBoxAnchor)) {
    state.infoBoxAnchor = DEFAULTS.infoBoxAnchor;
  }
  if (typeof state.infoBoxCollapsed !== "boolean") {
    state.infoBoxCollapsed = DEFAULTS.infoBoxCollapsed;
  }
  if (typeof state.experimentHome !== "boolean") {
    state.experimentHome = DEFAULTS.experimentHome;
  }
  if (!isOpenOnLaunch(state.openOnLaunch)) {
    state.openOnLaunch = DEFAULTS.openOnLaunch;
  }
}

class SettingsStore {
  state = $state<Settings>(structuredClone(DEFAULTS));
  ready = $state(false);

  async init() {
    if (this.ready) return;
    try {
      const stored = await loadSettings();
      const raw = stored as unknown as Record<string, unknown>;
      const migratedShortcuts = migrateShortcuts(stored.shortcuts);
      // Non-destructive on purpose: a default only lands where the user has
      // claimed neither its command nor its key, so shipping a new shortcut
      // never rewrites a keyboard somebody has already made their own.
      const mergedKeys = mergeDefaultKeybindings(sanitizeKeybindings(raw.keybindings));
      const inheritedSetup =
        Array.isArray(stored.shortcuts) && stored.shortcuts.length > 0;
      const backfilledSetup =
        typeof stored.setupCompleted !== "boolean" && inheritedSetup;
      this.state = {
        shortcuts: migratedShortcuts.shortcuts,
        keybindings: mergedKeys.bindings,
        powershellNewline:
          typeof stored.powershellNewline === "boolean"
            ? stored.powershellNewline
            : DEFAULTS.powershellNewline,
        powershellNoProfile:
          typeof stored.powershellNoProfile === "boolean"
            ? stored.powershellNoProfile
            : DEFAULTS.powershellNoProfile,
        threadWorktrees:
          typeof stored.threadWorktrees === "boolean"
            ? stored.threadWorktrees
            : DEFAULTS.threadWorktrees,
        defaultShellId:
          typeof stored.defaultShellId === "string"
            ? stored.defaultShellId
            : DEFAULTS.defaultShellId,
        sidebarWidth:
          typeof stored.sidebarWidth === "number" && stored.sidebarWidth > 0
            ? stored.sidebarWidth
            : DEFAULTS.sidebarWidth,
        sidebarCollapsed:
          typeof stored.sidebarCollapsed === "boolean"
            ? stored.sidebarCollapsed
            : DEFAULTS.sidebarCollapsed,
        uiScalePercent:
          typeof stored.uiScalePercent === "number" && stored.uiScalePercent > 0
            ? stored.uiScalePercent
            : DEFAULTS.uiScalePercent,
        projectOrder: Array.isArray(stored.projectOrder)
          ? stored.projectOrder
          : structuredClone(DEFAULTS.projectOrder),
        threadOrderByProject:
          stored.threadOrderByProject && typeof stored.threadOrderByProject === "object"
            ? stored.threadOrderByProject
            : structuredClone(DEFAULTS.threadOrderByProject),
        agentTodoAccess:
          typeof stored.agentTodoAccess === "boolean"
            ? stored.agentTodoAccess
            : DEFAULTS.agentTodoAccess,
        // Anything that is not exactly `true` is off. A blob from a build that
        // never had the key, or one whose value did not survive a round trip,
        // is a workspace nobody armed.
        mcpYolo: stored.mcpYolo === true,
        todoPromptTemplate:
          typeof stored.todoPromptTemplate === "string" && stored.todoPromptTemplate.trim()
            ? stored.todoPromptTemplate
            : DEFAULTS.todoPromptTemplate,
        idleTimeoutMinutes:
          typeof stored.idleTimeoutMinutes === "number" && stored.idleTimeoutMinutes >= 0
            ? stored.idleTimeoutMinutes
            : DEFAULTS.idleTimeoutMinutes,
        idleAutocloseByIcon:
          stored.idleAutocloseByIcon && typeof stored.idleAutocloseByIcon === "object"
            ? {
                ...structuredClone(DEFAULTS.idleAutocloseByIcon),
                ...stored.idleAutocloseByIcon,
              }
            : structuredClone(DEFAULTS.idleAutocloseByIcon),
        confirmCloseThread:
          typeof stored.confirmCloseThread === "boolean"
            ? stored.confirmCloseThread
            : DEFAULTS.confirmCloseThread,
        rightPanel: isRightPanelTab(stored.rightPanel)
          ? stored.rightPanel
          : DEFAULTS.rightPanel,
        rightPanelByProject: readRightPanelMap(stored.rightPanelByProject),
        rightPanelWidth:
          typeof stored.rightPanelWidth === "number" && stored.rightPanelWidth > 0
            ? stored.rightPanelWidth
            : DEFAULTS.rightPanelWidth,
        gitSplitFraction:
          typeof stored.gitSplitFraction === "number" &&
          stored.gitSplitFraction > 0 &&
          stored.gitSplitFraction < 1
            ? stored.gitSplitFraction
            : DEFAULTS.gitSplitFraction,
        gitAutoFetch:
          typeof stored.gitAutoFetch === "boolean"
            ? stored.gitAutoFetch
            : DEFAULTS.gitAutoFetch,
        gitAutoFetchSeconds:
          typeof stored.gitAutoFetchSeconds === "number" &&
          stored.gitAutoFetchSeconds >= GIT_AUTOFETCH_MIN_SECONDS
            ? Math.min(stored.gitAutoFetchSeconds, GIT_AUTOFETCH_MAX_SECONDS)
            : DEFAULTS.gitAutoFetchSeconds,
        mobileLayout:
          typeof stored.mobileLayout === "boolean"
            ? stored.mobileLayout
            : DEFAULTS.mobileLayout,
        fastpickEnabled:
          typeof stored.fastpickEnabled === "boolean"
            ? stored.fastpickEnabled
            : DEFAULTS.fastpickEnabled,
        colorByModel:
          typeof stored.colorByModel === "boolean"
            ? stored.colorByModel
            : DEFAULTS.colorByModel,
        sidebarDesign: readSidebarDesign(raw),
        sidebarHarnessLogos:
          typeof stored.sidebarHarnessLogos === "boolean"
            ? stored.sidebarHarnessLogos
            : DEFAULTS.sidebarHarnessLogos,
        experimentInfoBox:
          typeof stored.experimentInfoBox === "boolean"
            ? stored.experimentInfoBox
            : DEFAULTS.experimentInfoBox,
        infoBoxAnchor: isInfoBoxAnchor(stored.infoBoxAnchor)
          ? stored.infoBoxAnchor
          : DEFAULTS.infoBoxAnchor,
        infoBoxCollapsed:
          typeof stored.infoBoxCollapsed === "boolean"
            ? stored.infoBoxCollapsed
            : DEFAULTS.infoBoxCollapsed,
        experimentSmartSort:
          typeof stored.experimentSmartSort === "boolean"
            ? stored.experimentSmartSort
            : DEFAULTS.experimentSmartSort,
        experimentWhip:
          typeof stored.experimentWhip === "boolean"
            ? stored.experimentWhip
            : DEFAULTS.experimentWhip,
        whipSound: isWhipSound(stored.whipSound) ? stored.whipSound : DEFAULTS.whipSound,
        smartSortBy: isSmartSortBy(stored.smartSortBy)
          ? stored.smartSortBy
          : DEFAULTS.smartSortBy,
        smartSortDirection: isSortDirection(stored.smartSortDirection)
          ? stored.smartSortDirection
          : DEFAULTS.smartSortDirection,
        experimentHome:
          typeof stored.experimentHome === "boolean"
            ? stored.experimentHome
            : DEFAULTS.experimentHome,
        openOnLaunch: isOpenOnLaunch(stored.openOnLaunch)
          ? stored.openOnLaunch
          : DEFAULTS.openOnLaunch,
        // A settings row written before the wizard existed carries no flag.
        // Its owner already has a shortcut list, and finishing the wizard
        // replaces that list wholesale, so an existing install counts as
        // already set up. Only a genuinely empty install sees the wizard.
        setupCompleted:
          typeof stored.setupCompleted === "boolean"
            ? stored.setupCompleted
            : inheritedSetup,
        // Device-scoped: the localStorage override below is the real source, and
        // these two only matter as a one-shot migration from the era when the
        // whole blob was persisted together.
        motionMode: isMotionMode(stored.motionMode)
          ? stored.motionMode
          : DEFAULTS.motionMode,
        themeMode: isThemeMode(stored.themeMode)
          ? stored.themeMode
          : DEFAULTS.themeMode,
        uiFontFamily: readFamily(stored.uiFontFamily),
        terminalFontFamily: readFamily(stored.terminalFontFamily),
        terminalFontScalePercent:
          typeof stored.terminalFontScalePercent === "number"
            ? clampTerminalScale(stored.terminalFontScalePercent)
            : DEFAULTS.terminalFontScalePercent,
        locale: isLocaleSetting(stored.locale) ? stored.locale : DEFAULTS.locale,
        layoutPinned:
          typeof stored.layoutPinned === "boolean"
            ? stored.layoutPinned
            : DEFAULTS.layoutPinned,
      };
      // Device fields come from localStorage, overriding the backend blob. If
      // there is none yet, seed it from what the blob carried (one-shot
      // migration from the old whole-blob persistence).
      const dev = loadDeviceOverrides();
      if (dev) {
        applyDeviceOverrides(this.state, dev);
        // Device blobs written before 0.7.1 have no mobileLayout key, so a
        // phone that used an earlier build would stay on the PC layout. Seed it
        // from the form factor (a no-op on desktops) and persist so the choice
        // sticks; a manual toggle later overrides it for good.
        if (dev.mobileLayout === undefined) {
          this.state.mobileLayout = detectMobileDefault();
          this.state.layoutPinned = false;
          this.persistDeviceNow();
        } else if (typeof dev.v !== "number" || dev.v < DEVICE_BLOB_VERSION) {
          // Stamp the version and write the promoted keys down, so this load is
          // the only one that reads them off the workspace.
          this.persistDeviceNow();
        }
      } else {
        // No device blob yet: this machine's first run. Pick a sensible layout
        // from the form factor before seeding localStorage.
        this.state.mobileLayout = detectMobileDefault();
        this.state.layoutPinned = false;
        this.persistDeviceNow();
      }
      if (migratedShortcuts.changed || backfilledSetup || mergedKeys.changed) {
        await this.persist();
      }
    } catch (err) {
      logger.error("settings", "loadSettings failed", String(err));
    }
    // Push the hydrated locale before the first paint that follows: waiting on
    // an $effect would render one frame in the browser locale first.
    applyLocale(this.state.locale);
    this.ready = true;
  }

  // A workspace switch re-hydrates the workspace half from the new backend. The
  // device half does not change: the machine the user is sitting at is the one
  // constant across a switch.
  reset() {
    // Cancel the queued workspace write: a slider drag right before a switch
    // would otherwise flush ~250ms later against the swapped backend (backend()
    // resolves lazily), writing one workspace's settings into the other's DB.
    // The device write is deliberately left alone. It lands in localStorage,
    // which no switch can put out of reach, and cancelling it discarded a
    // sidebar drag or a zoom made in the 250ms before the switch.
    this.persistSoon.cancel();
    const dev = loadDeviceOverrides();
    this.state = structuredClone(DEFAULTS);
    // Re-applied here rather than left to init(), which cannot run until the
    // new backend answers. Resetting to the defaults in between flipped the UI
    // to the browser's language and the default zoom on every boite switch.
    if (dev) applyDeviceOverrides(this.state, dev);
    applyLocale(this.state.locale);
    this.ready = false;
  }

  // Backend stores workspace fields only; device/layout fields go to
  // localStorage so they never round-trip through a remote workspace DB.
  private async persist() {
    try {
      const snap = $state.snapshot(this.state) as Settings;
      const ws: Record<string, unknown> = { ...snap };
      for (const k of DEVICE_FIELDS) delete ws[k];
      await saveSettings(ws as unknown as Settings);
    } catch (err) {
      logger.error("settings", "saveSettings failed", String(err));
      notifications.error(t("settings.saveFailed"));
    }
  }

  private persistDeviceNow() {
    if (typeof localStorage === "undefined") return;
    const d: Record<string, unknown> = { v: DEVICE_BLOB_VERSION };
    for (const k of DEVICE_FIELDS) d[k] = this.state[k];
    try {
      localStorage.setItem(DEVICE_KEY, JSON.stringify(d));
    } catch (err) {
      logger.error("settings", "layout persist failed", String(err));
    }
  }

  // Coalesce rapid writes (slider drag, wheel zoom) into one write.
  private persistSoon = debounce(() => {
    void this.persist();
  }, 250);
  private persistDeviceSoon = debounce(() => {
    this.persistDeviceNow();
  }, 250);

  // A whole new array rather than a mutation: the compiled rules hang off this
  // reference, and an in-place edit would leave the dispatcher on the old ones.
  async setKeybindings(next: Keybinding[]) {
    this.state.keybindings = next;
    await this.persist();
  }

  async setPowershellNewline(value: boolean) {
    this.state.powershellNewline = value;
    await this.persist();
    notifications.success(
      value ? t("settings.psNewlineOn") : t("settings.psNewlineOff"),
    );
  }

  async setPowershellNoProfile(value: boolean) {
    this.state.powershellNoProfile = value;
    await this.persist();
    notifications.success(
      value ? t("settings.psNoProfileOn") : t("settings.psNoProfileOff"),
    );
  }

  async setDefaultShellId(id: string | null) {
    this.state.defaultShellId = id;
    await this.persist();
    // Probe the new shell now rather than leaving the next shortcut to decide
    // from the PATH alone, which is what a shell picked mid-session would
    // otherwise do until the app restarts.
    if (id) void backend().shell.warmShell(id).catch(() => {});
    notifications.success(
      id
        ? t("settings.defaultShellSet", { name: id })
        : t("settings.defaultShellNone"),
    );
  }

  async setDefaultShellIdQuiet(id: string | null) {
    this.state.defaultShellId = id;
    await this.persist();
  }

  setSidebarWidth(px: number) {
    const clamped = Math.max(180, Math.min(480, Math.round(px)));
    if (this.state.sidebarWidth === clamped) return;
    this.state.sidebarWidth = clamped;
    this.persistDeviceSoon();
  }

  toggleSidebar() {
    this.state.sidebarCollapsed = !this.state.sidebarCollapsed;
    this.persistDeviceNow();
  }

  /**
   * Which panel this project has open, or null for none.
   *
   * A project nobody has opened a panel on yet inherits the last choice made
   * anywhere, which is also the answer while on no project at all. That is not a
   * fallback for lack of data: arriving in a new project with git already up is
   * what somebody who works with git open means, and the first close is what
   * makes it that project's own answer.
   */
  rightPanelFor(projectId: string | null): RightPanelTab {
    if (projectId && projectId in this.state.rightPanelByProject) {
      return this.state.rightPanelByProject[projectId];
    }
    return this.state.rightPanel;
  }

  /**
   * What the three titlebar buttons do: show this panel, or close the column
   * when it is the one already showing.
   *
   * Clicking Todo while Git is up switches tabs rather than closing anything,
   * which is the whole point of the column — the second click on a panel you
   * are already looking at is the only one that changes the layout.
   */
  toggleRightPanel(projectId: string | null, tab: Exclude<RightPanelTab, null>) {
    this.setRightPanel(projectId, this.rightPanelFor(projectId) === tab ? null : tab);
  }

  setRightPanel(projectId: string | null, tab: RightPanelTab) {
    if (this.rightPanelFor(projectId) === tab && this.state.rightPanel === tab) return;
    this.state.rightPanel = tab;
    if (projectId) this.state.rightPanelByProject[projectId] = tab;
    this.persistDeviceNow();
  }

  /** A project that is gone keeps no memory: its entry would sit in the device
      blob forever, growing by one per project ever deleted. */
  forgetRightPanel(projectId: string) {
    if (!(projectId in this.state.rightPanelByProject)) return;
    delete this.state.rightPanelByProject[projectId];
    this.persistDeviceNow();
  }

  setRightPanelWidth(px: number) {
    const clamped = clampRightPanelWidth(px);
    if (this.state.rightPanelWidth === clamped) return;
    this.state.rightPanelWidth = clamped;
    this.persistDeviceSoon();
  }

  // A choice, unlike the first-run guess: from here the layout stops following
  // the form factor.
  setMobileLayout(value: boolean) {
    if (this.state.mobileLayout === value && this.state.layoutPinned) return;
    this.state.mobileLayout = value;
    this.state.layoutPinned = true;
    this.persistDeviceNow();
  }

  /**
   * Hands the layout back to the device.
   *
   * The pin was a one-way door: `setMobileLayout` sets it and nothing cleared
   * it, so one tap on the toggle meant a tablet stopped following its own
   * rotation for the life of the install, with nothing on screen saying the
   * choice had been made or how to take it back. Re-reads the form factor here
   * rather than waiting for the next media-query change, because the query only
   * fires when it crosses the threshold and a device sitting on the wrong side
   * of it would keep the pinned answer until it was rotated.
   */
  unpinLayout() {
    if (!this.state.layoutPinned) return;
    this.state.layoutPinned = false;
    this.state.mobileLayout = detectMobileDefault();
    this.persistDeviceNow();
  }

  /**
   * Keep an unpinned layout following the device.
   *
   * The form factor used to be read once, on the very first run, and written
   * straight to localStorage. A coarse-pointer tablet wider than the threshold
   * was then stuck on the PC layout for the life of the install. Returns a
   * cleanup for the media-query listener.
   */
  watchFormFactor(): () => void {
    if (typeof window === "undefined") return () => {};
    const query = window.matchMedia?.(MOBILE_LAYOUT_QUERY);
    if (!query) return () => {};
    const apply = () => {
      if (this.state.layoutPinned) return;
      if (this.state.mobileLayout === query.matches) return;
      this.state.mobileLayout = query.matches;
      this.persistDeviceNow();
    };
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }

  setMotionMode(value: Settings["motionMode"]) {
    if (this.state.motionMode === value) return;
    this.state.motionMode = value;
    this.persistDeviceNow();
  }

  setThemeMode(value: Settings["themeMode"]) {
    if (this.state.themeMode === value) return;
    this.state.themeMode = value;
    this.persistDeviceNow();
  }

  setUiFontFamily(value: string | null) {
    const next = readFamily(value);
    if (this.state.uiFontFamily === next) return;
    this.state.uiFontFamily = next;
    this.persistDeviceNow();
  }

  setTerminalFontFamily(value: string | null) {
    const next = readFamily(value);
    if (this.state.terminalFontFamily === next) return;
    this.state.terminalFontFamily = next;
    this.persistDeviceNow();
  }

  // Debounced like the other sliders: this arrives on every `oninput` of a
  // range, so a single drag is dozens of localStorage writes otherwise.
  setTerminalFontScalePercent(value: number) {
    const next = clampTerminalScale(value);
    if (this.state.terminalFontScalePercent === next) return;
    this.state.terminalFontScalePercent = next;
    this.persistDeviceSoon();
  }
  async setFastpickEnabled(value: boolean) {
    if (this.state.fastpickEnabled === value) return;
    this.state.fastpickEnabled = value;
    await this.persist();
  }

  setColorByModel(value: boolean) {
    if (this.state.colorByModel === value) return;
    this.state.colorByModel = value;
    this.persistDeviceNow();
  }

  setSidebarDesign(value: SidebarDesign) {
    if (this.state.sidebarDesign === value) return;
    this.state.sidebarDesign = value;
    this.persistDeviceNow();
  }

  setSidebarHarnessLogos(value: boolean) {
    if (this.state.sidebarHarnessLogos === value) return;
    this.state.sidebarHarnessLogos = value;
    this.persistDeviceNow();
  }

  setExperimentInfoBox(value: boolean) {
    if (this.state.experimentInfoBox === value) return;
    this.state.experimentInfoBox = value;
    this.persistDeviceNow();
  }

  setInfoBoxAnchor(value: InfoBoxAnchor) {
    if (!isInfoBoxAnchor(value) || this.state.infoBoxAnchor === value) return;
    this.state.infoBoxAnchor = value;
    this.persistDeviceNow();
  }

  setInfoBoxCollapsed(value: boolean) {
    if (this.state.infoBoxCollapsed === value) return;
    this.state.infoBoxCollapsed = value;
    this.persistDeviceNow();
  }

  setExperimentSmartSort(value: boolean) {
    if (this.state.experimentSmartSort === value) return;
    this.state.experimentSmartSort = value;
    this.persistDeviceNow();
  }

  setExperimentWhip(value: boolean) {
    if (this.state.experimentWhip === value) return;
    this.state.experimentWhip = value;
    this.persistDeviceNow();
  }

  setWhipSound(value: WhipSound) {
    if (this.state.whipSound === value) return;
    this.state.whipSound = value;
    this.persistDeviceNow();
  }

  setSmartSortBy(value: SmartSortBy) {
    if (this.state.smartSortBy === value) return;
    this.state.smartSortBy = value;
    this.persistDeviceNow();
  }

  setSmartSortDirection(value: SortDirection) {
    if (this.state.smartSortDirection === value) return;
    this.state.smartSortDirection = value;
    this.persistDeviceNow();
  }

  setExperimentHome(value: boolean) {
    if (this.state.experimentHome === value) return;
    this.state.experimentHome = value;
    this.persistDeviceNow();
  }

  setOpenOnLaunch(value: OpenOnLaunch) {
    if (!isOpenOnLaunch(value) || this.state.openOnLaunch === value) return;
    this.state.openOnLaunch = value;
    this.persistDeviceNow();
  }

  // `persist()` strips every device field before it writes, so a setter that
  // only calls it stores the value nowhere at all. That is what this one did:
  // the language survived in memory until the next reload and then reverted,
  // unless an unrelated device write happened to flush the blob in between.
  setLocale(value: LocaleSetting) {
    if (this.state.locale === value) return;
    this.state.locale = value;
    applyLocale(value);
    this.persistDeviceNow();
  }

  setUiScalePercent(percent: number) {
    const clamped = Math.max(75, Math.min(150, Math.round(percent)));
    if (this.state.uiScalePercent === clamped) return;
    this.state.uiScalePercent = clamped;
    this.persistDeviceSoon();
  }

  async setProjectOrder(ids: string[]) {
    this.state.projectOrder = ids;
    await this.persist();
  }

  async setThreadOrder(projectId: string, ids: string[]) {
    this.state.threadOrderByProject = {
      ...this.state.threadOrderByProject,
      [projectId]: ids,
    };
    await this.persist();
  }

  async addShortcut(partial: Partial<Shortcut> = {}) {
    const shortcut: Shortcut = {
      id: uuid(),
      label: partial.label?.trim() || "Shortcut",
      command: partial.command?.trim() ?? "",
      iconKey: partial.iconKey ?? null,
    };
    this.state.shortcuts.push(shortcut);
    await this.persist();
    notifications.success(t("settings.shortcutAdded", { label: shortcut.label }));
    return shortcut;
  }

  async updateShortcut(id: string, patch: Partial<Omit<Shortcut, "id">>) {
    const s = this.state.shortcuts.find((x) => x.id === id);
    if (!s) return;
    if (patch.label !== undefined) s.label = patch.label;
    if (patch.command !== undefined) s.command = patch.command;
    if (patch.iconKey !== undefined) s.iconKey = patch.iconKey;
    if (patch.iconColor !== undefined) s.iconColor = patch.iconColor;
    await this.persist();
    notifications.success(t("settings.shortcutSaved"));
  }

  async removeShortcut(id: string) {
    const s = this.state.shortcuts.find((x) => x.id === id);
    this.state.shortcuts = this.state.shortcuts.filter((x) => x.id !== id);
    await this.persist();
    notifications.success(
      s
        ? t("settings.shortcutRemoved", { label: s.label })
        : t("settings.shortcutRemovedUnnamed"),
    );
  }

  async setSetupCompleted(val: boolean) {
    this.state.setupCompleted = val;
    await this.persist();
  }

  /// Closes the wizard on the shortcut list it produced. Replacing the list is
  /// only ever right for an install that had none: init() backfills
  /// setupCompleted for anyone who already had shortcuts, so they never reach
  /// this.
  async completeSetup(shortcuts: Shortcut[]) {
    this.state.shortcuts = shortcuts;
    this.state.setupCompleted = true;
    await this.persist();
  }

  async reorderShortcuts(orderedIds: string[]) {
    const map = new Map(this.state.shortcuts.map((s) => [s.id, s]));
    const reordered: Shortcut[] = [];
    for (const id of orderedIds) {
      const s = map.get(id);
      if (s) reordered.push(s);
    }
    if (reordered.length !== this.state.shortcuts.length) return;
    this.state.shortcuts = reordered;
    await this.persist();
  }

  /// Same answer as the first run: the agents this machine has, in catalogue
  /// order. Restoring a fixed list instead would put back the ones whose binary
  /// is missing, which is the whole reason this list is detected and not shipped.
  async resetShortcutsToPresets() {
    const detected = await detectedShortcuts();
    // Detection answering nothing is not the same as this machine having no
    // agents: a probe fails wholesale when the backend transport is down, or
    // when a GUI launch left PATH without the shell's own additions. Persisting
    // that as an empty bar throws away every row the user built, with no undo
    // and a success toast on top.
    if (detected.length === 0) {
      notifications.error(t("settings.shortcutsResetFoundNothing"));
      return;
    }
    this.state.shortcuts = detected;
    await this.persist();
    notifications.success(t("settings.shortcutsReset"));
  }

  setIdleTimeoutMinutes(value: number) {
    const clamped = Math.max(0, Math.min(240, Math.round(value)));
    if (this.state.idleTimeoutMinutes === clamped) return;
    this.state.idleTimeoutMinutes = clamped;
    this.persistSoon();
  }

  async setIdleAutocloseForIcon(iconKey: string, on: boolean) {
    this.state.idleAutocloseByIcon = {
      ...this.state.idleAutocloseByIcon,
      [iconKey]: on,
    };
    await this.persist();
  }

  setConfirmCloseThread(value: boolean) {
    if (this.state.confirmCloseThread === value) return;
    this.state.confirmCloseThread = value;
    this.persistDeviceNow();
  }

  // The app-wide default behind Project > Worktrees. It was hydrated, read by
  // thread/api.ts when a thread is born, and had no setter and no UI: pinned on,
  // changeable only one project at a time.
  async setThreadWorktrees(value: boolean) {
    if (this.state.threadWorktrees === value) return;
    this.state.threadWorktrees = value;
    await this.persist();
  }

  /**
   * Persisted rather than kept here: the endpoint reads this out of the
   * workspace database on every gated call, so an unwritten toggle is a toggle
   * the agents never see.
   */
  async setMcpYolo(value: boolean) {
    if (this.state.mcpYolo === value) return;
    this.state.mcpYolo = value;
    await this.persist();
  }

  async setAgentTodoAccess(value: boolean) {
    if (this.state.agentTodoAccess === value) return;
    this.state.agentTodoAccess = value;
    await this.persist();
  }

  async setTodoPromptTemplate(value: string) {
    const next = value.trim() || DEFAULT_TODO_PROMPT;
    if (this.state.todoPromptTemplate === next) return;
    this.state.todoPromptTemplate = next;
    await this.persist();
  }

  setGitSplitFraction(value: number) {
    const clamped = Math.max(0.15, Math.min(0.85, value));
    if (Math.abs(this.state.gitSplitFraction - clamped) < 0.001) return;
    this.state.gitSplitFraction = clamped;
    this.persistDeviceSoon();
  }

  async setGitAutoFetch(value: boolean) {
    this.state.gitAutoFetch = value;
    await this.persist();
  }

  setGitAutoFetchSeconds(value: number) {
    const clamped = Math.max(
      GIT_AUTOFETCH_MIN_SECONDS,
      Math.min(GIT_AUTOFETCH_MAX_SECONDS, Math.round(value)),
    );
    if (this.state.gitAutoFetchSeconds === clamped) return;
    this.state.gitAutoFetchSeconds = clamped;
    this.persistSoon();
  }

}

export const settings = new SettingsStore();
