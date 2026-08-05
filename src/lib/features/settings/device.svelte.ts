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
  // The app version that boite was running the last time this device reached
  // it. Empty = never seen. Cached for the same reason the label is: the picker
  // has to say something about a boite it is not connected to, and the version
  // is the one thing there that says "this one is behind" before you switch.
  version: string;
}

interface DeviceState {
  boites: BoiteEntry[];
  activeBoiteId: string | null;
  // Dynamic mode preference: when on, connecting to a boite merges its
  // projects with the local ones instead of replacing the workspace.
  dynamicMode: boolean;
  /**
   * Which of a boite's projects this device shows, keyed by boite id.
   *
   * Dynamic mode used to graft every remote project onto the local list the
   * moment it was switched on, which on a boite with a dozen repositories is a
   * sidebar nobody asked for. The list is opt-in per project and per device: the
   * phone and the desktop want different halves of the same boite, and neither
   * choice belongs in the workspace database.
   *
   * A boite with no entry shows nothing, which is what "just turned it on"
   * looks like.
   */
  remoteProjects: Record<string, string[]>;
}

const DEFAULTS: DeviceState = {
  boites: [],
  activeBoiteId: null,
  dynamicMode: false,
  remoteProjects: {},
};

function normalizeRemoteProjects(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [boiteId, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(ids)) continue;
    out[boiteId] = ids.filter((id): id is string => typeof id === "string");
  }
  return out;
}

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
    version: typeof r.version === "string" ? r.version : "",
  };
}

/**
 * A blob written before projects could be picked one by one, on a device that
 * had dynamic mode on.
 *
 * Its owner was seeing every remote project, and shipping the opt-in list would
 * empty their sidebar with no explanation. Read once by `app.init()`, which
 * seeds the list from whatever the boite turns out to have; from then on the key
 * exists and this stays false.
 */
let legacyDynamic = false;

function load(): DeviceState {
  if (!hasStorage()) return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (Array.isArray(p.boites)) {
      legacyDynamic = p.dynamicMode === true && p.remoteProjects === undefined;
      const boites = p.boites
        .map(normalizeEntry)
        .filter((e): e is BoiteEntry => e !== null);
      const activeBoiteId =
        typeof p.activeBoiteId === "string" &&
        boites.some((b) => b.id === p.activeBoiteId)
          ? p.activeBoiteId
          : (boites[0]?.id ?? null);
      return {
        boites,
        activeBoiteId,
        dynamicMode: p.dynamicMode === true,
        remoteProjects: normalizeRemoteProjects(p.remoteProjects),
      };
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
        version: "",
      };
      return {
        boites: [entry],
        activeBoiteId: entry.id,
        dynamicMode: false,
        remoteProjects: {},
      };
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
    const entry: BoiteEntry = { id: uuid(), url, token, name: "", color: "", version: "" };
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
    if (patch.version !== undefined) b.version = patch.version;
    this.#persist();
  }

  removeBoite(id: string): void {
    this.state.boites = this.state.boites.filter((b) => b.id !== id);
    if (this.state.activeBoiteId === id) {
      this.state.activeBoiteId = this.state.boites[0]?.id ?? null;
    }
    delete this.state.remoteProjects[id];
    this.#persist();
  }

  /**
   * Whether this device is arriving from the era when dynamic mode showed
   * everything. True at most once per install, and only until the list is
   * written.
   */
  get needsRemoteProjectSeed(): boolean {
    return legacyDynamic;
  }

  /** Show all of them once, for a device that was already seeing all of them. */
  seedRemoteProjects(boiteId: string, projectIds: string[]): void {
    legacyDynamic = false;
    this.setRemoteProjects(boiteId, projectIds);
  }

  /** The project ids this device shows for that boite. Empty means none. */
  remoteProjectsOf(boiteId: string | null): string[] {
    if (!boiteId) return [];
    return this.state.remoteProjects[boiteId] ?? [];
  }

  isRemoteProjectShown(boiteId: string | null, projectId: string): boolean {
    if (!boiteId) return false;
    return this.remoteProjectsOf(boiteId).includes(projectId);
  }

  setRemoteProjectShown(boiteId: string, projectId: string, shown: boolean): void {
    const current = this.remoteProjectsOf(boiteId);
    if (current.includes(projectId) === shown) return;
    // Write the key, never spread the record: `$state` proxies keep their
    // identity per key, and a replaced object is a fresh proxy every consumer
    // has to re-read. See rules/performance.md.
    this.state.remoteProjects[boiteId] = shown
      ? [...current, projectId]
      : current.filter((id) => id !== projectId);
    this.#persist();
  }

  setRemoteProjects(boiteId: string, projectIds: string[]): void {
    this.state.remoteProjects[boiteId] = [...projectIds];
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
