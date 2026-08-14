import type { Backend, ControlEvent } from "../types";
import { workspace } from "../active.svelte";
import { device, type BoiteEntry } from "$lib/features/settings/device.svelte";
import { EnvironmentRuntime } from "./runtime.svelte";

/**
 * Every environment this device keeps connected beside the active workspace.
 *
 * The active boite is deliberately not in here: it is owned by
 * `app/workspace.ts`, which resets the stores around it and hydrates the app
 * from it. This registry owns the *others* — dialled, supervised, projected and
 * queryable without ever becoming the workspace on screen.
 *
 * Nothing in here retries. Each runtime's supervisor is the only thing that
 * decides to dial, and the two window listeners installed by `start()` are
 * events, not polls: with several environments live a per-environment interval
 * would multiply by N for no reading anybody asked for.
 */
class EnvironmentRegistry {
  runtimes = $state<EnvironmentRuntime[]>([]);

  /**
   * Where a pushed event goes once it is stamped with the environment it came
   * from. Installed by the app layer, because the store that consumes it
   * imports this module's neighbours and a direct import would close the loop.
   */
  onControl: ((envId: string, ev: ControlEvent) => void) | null = null;

  #started = false;
  #hiddenAt: number | null = null;
  #byId = new Map<string, EnvironmentRuntime>();

  start(): void {
    if (this.#started || typeof window === "undefined") return;
    this.#started = true;
    workspace.environmentResolver = (id) => this.backendOf(id);
    window.addEventListener("online", () => this.#each((r) => r.networkOnline()));
    window.addEventListener("offline", () => this.#each((r) => r.networkOffline()));
    document.addEventListener("visibilitychange", () => this.#visibility());
    this.reconcile();
  }

  /**
   * Bring the live set in line with the registrations and with whichever boite
   * is the active workspace. Idempotent: called after every switch and from the
   * picker, and a run that changes nothing touches no reactive state.
   */
  reconcile(): void {
    if (typeof window === "undefined") return;
    const wanted = new Map<string, BoiteEntry>();
    for (const entry of device.enabledBoites) {
      if (entry.id === workspace.activeBoiteId) continue;
      wanted.set(entry.id, entry);
    }
    let changed = false;
    const stale: string[] = [];
    for (const [id, runtime] of this.#byId) {
      if (wanted.has(id)) continue;
      runtime.dispose();
      stale.push(id);
    }
    for (const id of stale) this.#byId.delete(id);
    changed = stale.length > 0;
    for (const [id, entry] of wanted) {
      const existing = this.#byId.get(id);
      if (existing) {
        existing.setCredentials({ url: entry.url, token: entry.token });
        continue;
      }
      const runtime = new EnvironmentRuntime(
        id,
        { url: entry.url, token: entry.token },
        (envId, ev) => this.onControl?.(envId, ev),
      );
      this.#byId.set(id, runtime);
      runtime.start();
      changed = true;
    }
    if (changed) this.runtimes = [...this.#byId.values()];
  }

  get(id: string): EnvironmentRuntime | null {
    return this.#byId.get(id) ?? null;
  }

  backendOf(id: string): Backend | null {
    const runtime = this.#byId.get(id);
    return runtime?.connected ? runtime.backend : null;
  }

  /** The ones a fan-out can actually ask a question of. */
  get queryable(): EnvironmentRuntime[] {
    return this.runtimes.filter((r) => r.queryable);
  }

  /**
   * Forget an environment: its supervisor, its session, its projection cache,
   * its registration and the credential that came with it.
   */
  remove(id: string): void {
    const runtime = this.#byId.get(id);
    if (runtime) {
      runtime.dispose();
      this.#byId.delete(id);
      this.runtimes = [...this.#byId.values()];
    }
    device.removeBoite(id);
  }

  /** The user asked a blocked or waiting environment to try again now. */
  wake(id: string): void {
    this.#byId.get(id)?.wake();
  }

  #each(fn: (r: EnvironmentRuntime) => void): void {
    for (const runtime of this.#byId.values()) fn(runtime);
  }

  #visibility(): void {
    if (document.hidden) {
      this.#hiddenAt = Date.now();
      return;
    }
    const suspendedFor = this.#hiddenAt === null ? 0 : Date.now() - this.#hiddenAt;
    this.#hiddenAt = null;
    this.#each((r) => r.foregrounded(suspendedFor));
  }
}

export const environments = new EnvironmentRegistry();
