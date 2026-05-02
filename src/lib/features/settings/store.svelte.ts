import { loadSettings, saveSettings } from "$lib/storage/db";
import { notifications } from "$lib/features/notifications/store.svelte";
import type { Settings, Shortcut } from "$lib/types";

export const PRESET_SHORTCUTS: Shortcut[] = [
  { id: "claude", label: "Claude", command: "claude", iconKey: "claude" },
  { id: "codex", label: "Codex", command: "codex", iconKey: "codex" },
  { id: "opencode", label: "Opencode", command: "opencode", iconKey: "opencode" },
  { id: "cursor", label: "Cursor Agent", command: "cursor-agent", iconKey: "cursor" },
  { id: "gemini", label: "Gemini", command: "gemini", iconKey: "gemini" },
  { id: "copilot", label: "Copilot", command: "gh copilot", iconKey: "copilot" },
];

const DEFAULTS: Settings = {
  shortcuts: PRESET_SHORTCUTS,
  powershellNewline: true,
  defaultShellId: null,
  sidebarWidth: 240,
  uiScalePercent: 100,
  projectOrder: [],
  threadOrderByProject: {},
};

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

class SettingsStore {
  state = $state<Settings>(structuredClone(DEFAULTS));
  ready = $state(false);

  async init() {
    if (this.ready) return;
    try {
      const stored = await loadSettings();
      this.state = {
        shortcuts: Array.isArray(stored.shortcuts)
          ? stored.shortcuts
          : structuredClone(DEFAULTS.shortcuts),
        powershellNewline:
          typeof stored.powershellNewline === "boolean"
            ? stored.powershellNewline
            : DEFAULTS.powershellNewline,
        defaultShellId:
          typeof stored.defaultShellId === "string"
            ? stored.defaultShellId
            : DEFAULTS.defaultShellId,
        sidebarWidth:
          typeof stored.sidebarWidth === "number" && stored.sidebarWidth > 0
            ? stored.sidebarWidth
            : DEFAULTS.sidebarWidth,
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
      };
    } catch (err) {
      console.error("loadSettings failed:", err);
    }
    this.ready = true;
  }

  private async persist() {
    try {
      await saveSettings($state.snapshot(this.state) as Settings);
    } catch (err) {
      console.error("saveSettings failed:", err);
      notifications.error("Failed to save settings");
    }
  }

  async setPowershellNewline(value: boolean) {
    this.state.powershellNewline = value;
    await this.persist();
    notifications.success(value ? "PowerShell newline on" : "PowerShell newline off");
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

  async setSidebarWidth(px: number) {
    const clamped = Math.max(180, Math.min(480, Math.round(px)));
    this.state.sidebarWidth = clamped;
    await this.persist();
  }

  async setUiScalePercent(percent: number) {
    const clamped = Math.max(75, Math.min(150, Math.round(percent)));
    this.state.uiScalePercent = clamped;
    await this.persist();
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
}

export const settings = new SettingsStore();
