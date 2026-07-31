import { uuid } from "$lib/shared/utils/uuid";
import { logger } from "$lib/shared/services/logger.svelte";

// Device-scoped settings: per-machine, never synced to a workspace. Holds the
// registry of saved boites (remote servers). Tokens are secrets and inherently
// per-device, so the list lives in localStorage, not in any workspace DB. A
// boite's name/color are server-synced (cosmetic, shared across devices); the
// copy cached here is only what this device last saw, used to label the picker
// before a connection is established.
const KEY = "boite.device";

export interface BoiteEntry {
  id: string;
  url: string;
  token: string;
  // Last-seen server identity. Empty string = unknown (fall back to host).
  name: string;
  color: string;
}

interface DeviceState {
  boites: BoiteEntry[];
  activeBoiteId: string | null;
  // Dynamic mode preference: when on, connecting to a boite merges its
  // projects with the local ones instead of replacing the workspace.
  dynamicMode: boolean;
}

const DEFAULTS: DeviceState = { boites: [], activeBoiteId: null, dynamicMode: false };

function hasStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function normalizeEntry(raw: unknown): BoiteEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== "string" || typeof r.token !== "string") return null;
  return {
    id: typeof r.id === "string" && r.id ? r.id : uuid(),
    url: r.url,
    token: r.token,
    name: typeof r.name === "string" ? r.name : "",
    color: typeof r.color === "string" ? r.color : "",
  };
}

function load(): DeviceState {
  if (!hasStorage()) return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (Array.isArray(p.boites)) {
      const boites = p.boites
        .map(normalizeEntry)
        .filter((e): e is BoiteEntry => e !== null);
      const activeBoiteId =
        typeof p.activeBoiteId === "string" &&
        boites.some((b) => b.id === p.activeBoiteId)
          ? p.activeBoiteId
          : (boites[0]?.id ?? null);
      return { boites, activeBoiteId, dynamicMode: p.dynamicMode === true };
    }
    // Migrate the pre-multi-boite shape ({ remoteUrl, remoteToken }) into a
    // single entry so an existing PWA/desktop keeps its saved connection.
    if (typeof p.remoteUrl === "string" && typeof p.remoteToken === "string" && p.remoteToken) {
      const entry: BoiteEntry = {
        id: uuid(),
        url: p.remoteUrl,
        token: p.remoteToken,
        name: "",
        color: "",
      };
      return { boites: [entry], activeBoiteId: entry.id, dynamicMode: false };
    }
    return { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

class DeviceSettings {
  state = $state<DeviceState>(load());

  get boites(): BoiteEntry[] {
    return this.state.boites;
  }

  get active(): BoiteEntry | null {
    const id = this.state.activeBoiteId;
    return id ? this.state.boites.find((b) => b.id === id) ?? null : null;
  }

  getBoite(id: string): BoiteEntry | null {
    return this.state.boites.find((b) => b.id === id) ?? null;
  }

  // Add a boite, or update the token of an existing one with the same URL
  // (re-pairing the same server). Returns the entry. Marks it active.
  addBoite(url: string, token: string): BoiteEntry {
    const existing = this.state.boites.find((b) => b.url === url);
    if (existing) {
      existing.token = token;
      this.state.activeBoiteId = existing.id;
      this.#persist();
      return existing;
    }
    const entry: BoiteEntry = { id: uuid(), url, token, name: "", color: "" };
    this.state.boites.push(entry);
    this.state.activeBoiteId = entry.id;
    this.#persist();
    return entry;
  }

  updateBoite(id: string, patch: Partial<Omit<BoiteEntry, "id">>): void {
    const b = this.state.boites.find((x) => x.id === id);
    if (!b) return;
    if (patch.url !== undefined) b.url = patch.url;
    if (patch.token !== undefined) b.token = patch.token;
    if (patch.name !== undefined) b.name = patch.name;
    if (patch.color !== undefined) b.color = patch.color;
    this.#persist();
  }

  removeBoite(id: string): void {
    this.state.boites = this.state.boites.filter((b) => b.id !== id);
    if (this.state.activeBoiteId === id) {
      this.state.activeBoiteId = this.state.boites[0]?.id ?? null;
    }
    this.#persist();
  }

  setActive(id: string | null): void {
    this.state.activeBoiteId = id;
    this.#persist();
  }

  get dynamicMode(): boolean {
    return this.state.dynamicMode;
  }

  setDynamicMode(value: boolean): void {
    this.state.dynamicMode = value;
    this.#persist();
  }

  #persist() {
    if (!hasStorage()) return;
    try {
      localStorage.setItem(KEY, JSON.stringify($state.snapshot(this.state)));
    } catch (err) {
      logger.error("settings", "device settings persist failed", String(err));
    }
  }
}

export const device = new DeviceSettings();
