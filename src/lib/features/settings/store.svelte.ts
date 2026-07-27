import { backend } from "$lib/backend";
import { loadSettings, saveSettings } from "$lib/storage/db";
import { notifications } from "$lib/features/notifications/store.svelte";
import { isLocaleSetting, setLocale as applyLocale } from "$lib/i18n/index.svelte";
import { debounce } from "$lib/shared/utils/debounce";
import { uuid } from "$lib/shared/utils/uuid";
import type { LocaleSetting, RightPanelTab, Settings, Shortcut } from "$lib/types";

export const PRESET_SHORTCUTS: Shortcut[] = [
  { id: "claude", label: "Claude", command: "claude", iconKey: "claude" },
  {
    id: "codex",
    label: "Codex",
    command: "codex --no-alt-screen",
    iconKey: "codex",
  },
  { id: "opencode", label: "Opencode", command: "opencode", iconKey: "opencode" },
  { id: "cursor", label: "Cursor Agent", command: "cursor-agent", iconKey: "cursor" },
  { id: "antigravity", label: "Antigravity", command: "agy", iconKey: "antigravity" },
  { id: "copilot", label: "Copilot", command: "gh copilot", iconKey: "copilot" },
  { id: "grok", label: "Grok", command: "grok", iconKey: "grok" },
  { id: "hermes", label: "Hermes", command: "hermes", iconKey: "hermes" },
];

// Presets introduced after the initial release: backfilled into existing
// installs exactly once, then recorded in `seededPresets` so a user deleting
// one doesn't get it back on the next launch.
const BACKFILL_PRESET_IDS = ["antigravity", "grok", "hermes"];

function migrateShortcuts(
  raw: unknown,
  seededRaw: unknown,
): { shortcuts: Shortcut[]; seededPresets: string[]; changed: boolean } {
  if (!Array.isArray(raw)) {
    return {
      shortcuts: structuredClone(DEFAULTS.shortcuts),
      seededPresets: [...BACKFILL_PRESET_IDS],
      changed: false,
    };
  }

  // A blob predating this key comes from a build that already backfilled on
  // every load, so any missing preset was deleted on purpose: mark them seeded
  // instead of re-adding them one last time.
  const legacyBlob = !Array.isArray(seededRaw);
  const seeded = new Set(
    legacyBlob
      ? BACKFILL_PRESET_IDS
      : (seededRaw as unknown[]).filter((id): id is string => typeof id === "string"),
  );

  let changed = legacyBlob;
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

  for (const presetId of BACKFILL_PRESET_IDS) {
    if (seeded.has(presetId)) continue;
    seeded.add(presetId);
    changed = true;
    const preset = PRESET_SHORTCUTS.find((s) => s.id === presetId);
    if (preset && !shortcuts.some((s) => s.id === presetId)) {
      shortcuts.push(structuredClone(preset));
    }
  }

  return { shortcuts, seededPresets: [...seeded], changed };
}

// Handing a terse note straight to an agent wastes the first turn on it asking
// what you meant. The scaffold spends that turn up front, and carries the id so
// the agent can report back through the MCP endpoint instead of you relaying it.
export const DEFAULT_TODO_PROMPT = `Task from my Boite todo list (id {{id}}):

{{task}}

Before changing anything: restate what you understand, name the files involved, and propose a plan. When it is done, call the boite MCP tool todo_claim with that id, a one-line summary of what changed, and the commit sha if you committed — leave it out rather than guessing, Boite reads it back from the repository.

You are working in your own detached worktree of this project, so nothing you do disturbs the other terminals. It is on no branch: if this turns into work worth keeping, call worktree_branch with a name that matches the repository's existing convention, or worktree_reserve to continue a branch that already exists. Do it once you know, not up front — a worktree nobody claimed is discarded when the thread closes, which is the right ending for a question you only answered.`;

const DEFAULTS: Settings = {
  shortcuts: PRESET_SHORTCUTS,
  seededPresets: BACKFILL_PRESET_IDS,
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
  },
  confirmCloseThread: true,
  rightPanel: null,
  rightPanelWidth: 320,
  gitSplitFraction: 0.5,
  gitAutoFetch: true,
  gitAutoFetchSeconds: 180,
  mobileLayout: false,
  motionMode: "system",
  locale: "system",
  setupCompleted: false,
};

// First-run guess: touch-primary, narrow screens (a phone TWA/PWA) default to
// the mobile layout. The toggle in Appearance overrides it permanently after.
function detectMobileDefault(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
    return coarse && window.innerWidth < 900;
  } catch {
    return false;
  }
}

export const GIT_AUTOFETCH_MIN_SECONDS = 30;
export const GIT_AUTOFETCH_MAX_SECONDS = 3600;

function migrateRightPanel(stored: Record<string, unknown>): RightPanelTab {
  const raw = stored.rightPanel;
  if (raw === "git" || raw === "explorer" || raw === "todo" || raw === null) return raw;
  if (stored.gitPanelOpen === true) return "git";
  return DEFAULTS.rightPanel;
}

function migrateRightPanelWidth(stored: Record<string, unknown>): number {
  if (typeof stored.rightPanelWidth === "number" && stored.rightPanelWidth > 0) {
    return stored.rightPanelWidth;
  }
  if (typeof stored.gitPanelWidth === "number" && stored.gitPanelWidth > 0) {
    return stored.gitPanelWidth;
  }
  return DEFAULTS.rightPanelWidth;
}

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

// Layout/device-scoped fields: per-machine, never stored in a workspace DB.
// They live in localStorage so switching to a remote workspace keeps your
// sidebar width and zoom while shortcuts/shells come from the server.
const DEVICE_KEY = "boite.layout";
const DEVICE_FIELDS = [
  "sidebarWidth",
  "sidebarCollapsed",
  "uiScalePercent",
  "rightPanel",
  "rightPanelWidth",
  "gitSplitFraction",
  "mobileLayout",
  "motionMode",
  "locale",
] as const;

function loadDeviceOverrides(): Partial<Settings> | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Settings>) : null;
  } catch {
    return null;
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
      const migratedShortcuts = migrateShortcuts(stored.shortcuts, raw.seededPresets);
      const inheritedSetup =
        Array.isArray(stored.shortcuts) && stored.shortcuts.length > 0;
      const backfilledSetup =
        typeof stored.setupCompleted !== "boolean" && inheritedSetup;
      this.state = {
        shortcuts: migratedShortcuts.shortcuts,
        seededPresets: migratedShortcuts.seededPresets,
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
        rightPanel: migrateRightPanel(raw),
        rightPanelWidth: migrateRightPanelWidth(raw),
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
        // A settings row written before the wizard existed carries no flag.
        // Its owner already has a shortcut list, and finishing the wizard
        // replaces that list wholesale, so an existing install counts as
        // already set up. Only a genuinely empty install sees the wizard.
        setupCompleted:
          typeof stored.setupCompleted === "boolean"
            ? stored.setupCompleted
            : inheritedSetup,
        // Device-scoped; the localStorage override below is the real source.
        motionMode: DEFAULTS.motionMode,
        locale: isLocaleSetting(stored.locale) ? stored.locale : DEFAULTS.locale,
      };
      // Device fields come from localStorage, overriding the backend blob. If
      // there is none yet, seed it from what the blob carried (one-shot
      // migration from the old whole-blob persistence).
      const dev = loadDeviceOverrides();
      if (dev) {
        const target = this.state as unknown as Record<string, unknown>;
        for (const k of DEVICE_FIELDS) {
          if (dev[k] !== undefined) target[k] = dev[k];
        }
        // Device blobs written before 0.7.1 have no mobileLayout key, so a
        // phone that used an earlier build would stay on the PC layout. Seed it
        // from the form factor (a no-op on desktops) and persist so the choice
        // sticks; a manual toggle later overrides it for good.
        if (dev.mobileLayout === undefined) {
          this.state.mobileLayout = detectMobileDefault();
          this.persistDeviceNow();
        }
      } else {
        // No device blob yet: this machine's first run. Pick a sensible layout
        // from the form factor before seeding localStorage.
        this.state.mobileLayout = detectMobileDefault();
        this.persistDeviceNow();
      }
      if (migratedShortcuts.changed || backfilledSetup) {
        await this.persist();
      }
    } catch (err) {
      console.error("loadSettings failed:", err);
    }
    // Push the hydrated locale before the first paint that follows: waiting on
    // an $effect would render one frame in the browser locale first.
    applyLocale(this.state.locale);
    this.ready = true;
  }

  // A workspace switch re-hydrates settings from the new backend.
  reset() {
    // Cancel queued debounced writes: a slider drag right before a switch
    // would otherwise flush ~250ms later against the swapped backend (backend()
    // resolves lazily), writing one workspace's settings into the other's DB.
    this.persistSoon.cancel();
    this.persistDeviceSoon.cancel();
    this.state = structuredClone(DEFAULTS);
    applyLocale(DEFAULTS.locale);
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
      console.error("saveSettings failed:", err);
      notifications.error("Failed to save settings");
    }
  }

  private persistDeviceNow() {
    if (typeof localStorage === "undefined") return;
    const d: Record<string, unknown> = {};
    for (const k of DEVICE_FIELDS) d[k] = this.state[k];
    try {
      localStorage.setItem(DEVICE_KEY, JSON.stringify(d));
    } catch (err) {
      console.error("layout persist failed:", err);
    }
  }

  // Coalesce rapid writes (slider drag, wheel zoom) into one write.
  private persistSoon = debounce(() => {
    void this.persist();
  }, 250);
  private persistDeviceSoon = debounce(() => {
    this.persistDeviceNow();
  }, 250);

  async setPowershellNewline(value: boolean) {
    this.state.powershellNewline = value;
    await this.persist();
    notifications.success(value ? "PowerShell newline on" : "PowerShell newline off");
  }

  async setPowershellNoProfile(value: boolean) {
    this.state.powershellNoProfile = value;
    await this.persist();
    notifications.success(
      value ? "PowerShell profile skipped (-NoProfile)" : "PowerShell profile loaded",
    );
  }

  async setDefaultShellId(id: string | null) {
    this.state.defaultShellId = id;
    await this.persist();
    // Probe the new shell now rather than leaving the next shortcut to decide
    // from the PATH alone, which is what a shell picked mid-session would
    // otherwise do until the app restarts.
    if (id) void backend().shell.warmShell(id).catch(() => {});
    notifications.success(id ? `Default shell: ${id}` : "Default shell: none");
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

  setMobileLayout(value: boolean) {
    if (this.state.mobileLayout === value) return;
    this.state.mobileLayout = value;
    this.persistDeviceNow();
  }

  setMotionMode(value: Settings["motionMode"]) {
    if (this.state.motionMode === value) return;
    this.state.motionMode = value;
    this.persistDeviceNow();
  }
  async setLocale(value: LocaleSetting) {
    if (this.state.locale === value) return;
    this.state.locale = value;
    applyLocale(value);
    await this.persist();
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
    notifications.success(`Added ${shortcut.label}`);
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
    notifications.success("Shortcut saved");
  }

  async removeShortcut(id: string) {
    const s = this.state.shortcuts.find((x) => x.id === id);
    this.state.shortcuts = this.state.shortcuts.filter((x) => x.id !== id);
    await this.persist();
    notifications.success(`Removed ${s?.label ?? "shortcut"}`);
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

  async resetShortcutsToPresets() {
    this.state.shortcuts = structuredClone(PRESET_SHORTCUTS);
    this.state.seededPresets = [...BACKFILL_PRESET_IDS];
    await this.persist();
    notifications.success("Shortcuts reset to defaults");
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

  async setConfirmCloseThread(value: boolean) {
    this.state.confirmCloseThread = value;
    await this.persist();
  }

  toggleRightPanel(tab: Exclude<RightPanelTab, null>) {
    this.state.rightPanel = this.state.rightPanel === tab ? null : tab;
    this.persistDeviceNow();
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

  togglePanelRight() {
    this.state.rightPanel = this.state.rightPanel === null ? "git" : null;
    this.persistDeviceNow();
  }

  setRightPanel(tab: RightPanelTab) {
    if (this.state.rightPanel === tab) return;
    this.state.rightPanel = tab;
    this.persistDeviceNow();
  }

  setRightPanelWidth(px: number) {
    const clamped = Math.max(240, Math.min(600, Math.round(px)));
    if (this.state.rightPanelWidth === clamped) return;
    this.state.rightPanelWidth = clamped;
    this.persistDeviceSoon();
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
