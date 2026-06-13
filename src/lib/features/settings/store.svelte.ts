import { loadSettings, saveSettings } from "$lib/storage/db";
import { notifications } from "$lib/features/notifications/store.svelte";
import { debounce } from "$lib/shared/utils/debounce";
import type { RightPanelTab, Settings, Shortcut } from "$lib/types";

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
];

function migrateShortcuts(raw: unknown): { shortcuts: Shortcut[]; changed: boolean } {
  if (!Array.isArray(raw)) {
    return { shortcuts: structuredClone(DEFAULTS.shortcuts), changed: false };
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

  const antigravityPreset = PRESET_SHORTCUTS.find((s) => s.id === "antigravity");
  if (antigravityPreset && !shortcuts.some((s) => s.id === "antigravity")) {
    shortcuts.push(structuredClone(antigravityPreset));
    changed = true;
  }

  return { shortcuts, changed };
}

const DEFAULTS: Settings = {
  shortcuts: PRESET_SHORTCUTS,
  powershellNewline: true,
  powershellNoProfile: false,
  defaultShellId: null,
  sidebarWidth: 240,
  sidebarCollapsed: false,
  uiScalePercent: 100,
  projectOrder: [],
  threadOrderByProject: {},
  idleTimeoutMinutes: 10,
  idleAutocloseByIcon: {
    claude: true,
    codex: true,
    opencode: true,
    cursor: true,
    antigravity: true,
    copilot: true,
  },
  confirmCloseThread: true,
  rightPanel: null,
  rightPanelWidth: 320,
  gitSplitFraction: 0.5,
  gitAutoFetch: true,
  gitAutoFetchSeconds: 180,
};

export const GIT_AUTOFETCH_MIN_SECONDS = 30;
export const GIT_AUTOFETCH_MAX_SECONDS = 3600;

function migrateRightPanel(stored: Record<string, unknown>): RightPanelTab {
  const raw = stored.rightPanel;
  if (raw === "git" || raw === "explorer" || raw === null) return raw;
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
] as const;
type DeviceField = (typeof DEVICE_FIELDS)[number];

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
      const migratedShortcuts = migrateShortcuts(stored.shortcuts);
      this.state = {
        shortcuts: migratedShortcuts.shortcuts,
        powershellNewline:
          typeof stored.powershellNewline === "boolean"
            ? stored.powershellNewline
            : DEFAULTS.powershellNewline,
        powershellNoProfile:
          typeof stored.powershellNoProfile === "boolean"
            ? stored.powershellNoProfile
            : DEFAULTS.powershellNoProfile,
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
      } else {
        this.persistDeviceNow();
      }
      if (migratedShortcuts.changed) {
        await this.persist();
      }
    } catch (err) {
      console.error("loadSettings failed:", err);
    }
    this.ready = true;
  }

  // A workspace switch re-hydrates settings from the new backend.
  reset() {
    this.state = structuredClone(DEFAULTS);
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
      id: crypto.randomUUID(),
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
    await this.persist();
    notifications.success("Shortcut saved");
  }

  async removeShortcut(id: string) {
    const s = this.state.shortcuts.find((x) => x.id === id);
    this.state.shortcuts = this.state.shortcuts.filter((x) => x.id !== id);
    await this.persist();
    notifications.success(`Removed ${s?.label ?? "shortcut"}`);
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
