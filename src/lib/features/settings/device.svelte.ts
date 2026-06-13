// Device-scoped settings: per-machine, never synced to a workspace. Phase 4
// needs the remote URL/token here (a workspace can't store how to reach
// itself); Phase 5 moves UI-scale, sidebar width, etc. here too.
const KEY = "boite.device";

interface DeviceState {
  remoteUrl: string;
  remoteToken: string;
}

const DEFAULTS: DeviceState = { remoteUrl: "", remoteToken: "" };

function hasStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function load(): DeviceState {
  if (!hasStorage()) return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<DeviceState>;
    return {
      remoteUrl: typeof p.remoteUrl === "string" ? p.remoteUrl : "",
      remoteToken: typeof p.remoteToken === "string" ? p.remoteToken : "",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

class DeviceSettings {
  state = $state<DeviceState>(load());

  setRemote(url: string, token: string) {
    this.state.remoteUrl = url;
    this.state.remoteToken = token;
    this.#persist();
  }

  #persist() {
    if (!hasStorage()) return;
    try {
      localStorage.setItem(KEY, JSON.stringify($state.snapshot(this.state)));
    } catch (err) {
      console.error("device settings persist failed:", err);
    }
  }
}

export const device = new DeviceSettings();
