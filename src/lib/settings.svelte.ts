import { loadSettings, saveSettings } from "./db";

export type IconKey =
  | "claude"
  | "codex"
  | "gemini"
  | "cursor"
  | "copilot"
  | "opencode"
  | "terminal"
  | null;

export interface Shortcut {
  id: string;
  label: string;
  command: string;
  iconKey?: IconKey;
}

export interface Settings {
  shortcuts: Shortcut[];
  powershellNewline: boolean;
}

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
    }
  }

  async setPowershellNewline(value: boolean) {
    this.state.powershellNewline = value;
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
    return shortcut;
  }

  async updateShortcut(id: string, patch: Partial<Omit<Shortcut, "id">>) {
    const s = this.state.shortcuts.find((x) => x.id === id);
    if (!s) return;
    if (patch.label !== undefined) s.label = patch.label;
    if (patch.command !== undefined) s.command = patch.command;
    if (patch.iconKey !== undefined) s.iconKey = patch.iconKey;
    await this.persist();
  }

  async removeShortcut(id: string) {
    this.state.shortcuts = this.state.shortcuts.filter((s) => s.id !== id);
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
    await this.persist();
  }
}

export const settings = new SettingsStore();
