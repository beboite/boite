import { loadSettings, saveSettings } from "./db";

export interface Shortcut {
  id: string;
  label: string;
  command: string;
}

export interface Settings {
  shortcuts: Shortcut[];
  powershellNewline: boolean;
}

export const PRESET_SHORTCUTS: Shortcut[] = [
  { id: "claude", label: "Claude CLI", command: "claude" },
  { id: "codex", label: "Codex", command: "codex" },
  { id: "opencode", label: "Opencode", command: "opencode" },
  { id: "cursor", label: "Cursor Agent", command: "cursor-agent" },
  { id: "gemini", label: "Gemini CLI", command: "gemini" },
  { id: "copilot", label: "Copilot CLI", command: "gh copilot" },
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
    await this.persist();
  }

  async removeShortcut(id: string) {
    this.state.shortcuts = this.state.shortcuts.filter((s) => s.id !== id);
    await this.persist();
  }

  async resetShortcutsToPresets() {
    this.state.shortcuts = structuredClone(PRESET_SHORTCUTS);
    await this.persist();
  }
}

export const settings = new SettingsStore();
