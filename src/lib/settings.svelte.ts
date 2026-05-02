import { loadSettings, saveSettings } from "./db";

export interface CommandPreset {
  id: string;
  label: string;
  cmd: string;
  args: string[];
}

export const PRESETS: CommandPreset[] = [
  { id: "claude", label: "Claude Code", cmd: "claude", args: [] },
  { id: "codex", label: "Codex", cmd: "codex", args: [] },
  { id: "gemini", label: "Gemini", cmd: "gemini", args: [] },
  { id: "pwsh", label: "PowerShell", cmd: "pwsh", args: [] },
  { id: "bash", label: "Bash", cmd: "bash", args: [] },
];

export interface Settings {
  defaultCmd: string;
  defaultArgs: string[];
  powershellNewline: boolean;
}

const DEFAULTS: Settings = {
  defaultCmd: "claude",
  defaultArgs: [],
  powershellNewline: true,
};

class SettingsStore {
  state = $state<Settings>({ ...DEFAULTS });
  ready = $state(false);

  async init() {
    if (this.ready) return;
    try {
      const stored = await loadSettings();
      this.state = { ...DEFAULTS, ...stored };
    } catch (err) {
      console.error("loadSettings failed:", err);
    }
    this.ready = true;
  }

  async update(patch: Partial<Settings>) {
    this.state = { ...this.state, ...patch };
    try {
      await saveSettings(this.state);
    } catch (err) {
      console.error("saveSettings failed:", err);
    }
  }
}

export const settings = new SettingsStore();
