import { backend, workspace } from "$lib/backend";
import { FASTPICK_CMD } from "./combo";
import type { FastpickListing, FastpickModels } from "$lib/backend/types";

/**
 * What fastpick says this machine can launch.
 *
 * Split in two on purpose, the way fastpick splits it. The harnesses and providers cost
 * nothing to list, so the menu opens on them immediately; a provider's models cost one HTTP
 * request, so they are asked for only when that provider is picked, and fastpick answers
 * from its own cache unless the user asks it to go and look again.
 *
 * Everything here crosses the transport, so on a remote boite it describes the server: its
 * fastpick config, its key files, its PATH. That is the machine the thread will run on.
 */
class FastpickStore {
  /** Null until probed. Tells "no fastpick on this machine" apart from "not asked yet". */
  installed = $state<boolean | null>(null);
  listing = $state<FastpickListing | null>(null);
  /** fastpick's own message when the config is missing or unusable. */
  error = $state<string | null>(null);
  loading = $state(false);

  /** What that machine's fastpick reports for `--version`. Only the settings panel asks. */
  version = $state<string | null>(null);
  /** Whether a Rust toolchain is there to install fastpick with. Null until probed. */
  cargoPresent = $state<boolean | null>(null);
  probing = $state(false);

  models = $state<Record<string, FastpickModels>>({});
  modelsError = $state<Record<string, string>>({});
  loadingModels = $state<string | null>(null);

  // Which workspace these answers describe. Switching boite invalidates all of them: a
  // provider list from another machine is worse than none.
  #loadedFor: string | null = null;

  get #target(): string {
    return workspace.activeBoiteId ?? "local";
  }

  /** Probes and lists once per workspace. Cheap to call on every menu open. */
  async ensure(): Promise<void> {
    if (this.#loadedFor === this.#target) return;
    await this.reload();
  }

  async reload(): Promise<void> {
    const target = this.#target;
    this.#loadedFor = target;
    this.listing = null;
    this.models = {};
    this.modelsError = {};
    this.error = null;
    this.loading = true;
    try {
      this.installed = await backend().shell.commandExists(FASTPICK_CMD);
      if (!this.installed) return;
      this.listing = await backend().fastpick.list();
    } catch (err) {
      // fastpick puts a usable sentence on stderr and the backend carries it through, so
      // this is worth showing rather than replacing with a generic failure.
      this.error = String(err);
    } finally {
      // A workspace switch mid-flight leaves this answering the wrong machine, and the
      // reload it started owns the flag from then on.
      if (this.#loadedFor === target) this.loading = false;
    }
  }

  /**
   * That provider's models. Served from what was already fetched unless `refresh`, so
   * walking back and forth in the menu costs nothing.
   */
  async loadModels(providerId: string, refresh = false): Promise<void> {
    if (!refresh && this.models[providerId]) return;
    this.loadingModels = providerId;
    delete this.modelsError[providerId];
    try {
      const listing = await backend().fastpick.list(providerId, refresh);
      if (listing.models) this.models[providerId] = listing.models;
    } catch (err) {
      this.modelsError[providerId] = String(err);
    } finally {
      if (this.loadingModels === providerId) this.loadingModels = null;
    }
  }

  /**
   * Asks that machine what it has: fastpick, its version, and a toolchain to build it with.
   *
   * Separate from `reload()` because only the settings panel needs it, and it is what the
   * panel calls again after an install thread has finished compiling. It reloads the
   * listing too: a fastpick that has just appeared has choices nobody has listed yet.
   */
  async probe(): Promise<void> {
    this.probing = true;
    try {
      const [version, cargo] = await Promise.all([
        backend().fastpick.version(),
        backend().shell.commandExists("cargo"),
      ]);
      this.version = version;
      this.cargoPresent = cargo;
      const had = this.installed;
      this.installed = version !== null;
      // A fastpick that was not there when the menu last looked has a config to list now.
      if (this.installed && had !== true) {
        this.#loadedFor = null;
        await this.ensure();
      }
    } finally {
      this.probing = false;
    }
  }

  /**
   * A provider by id, or null while the listing is still missing.
   *
   * Null is a real answer here rather than a failure: the icon tint falls back to the model
   * id, which is enough until the listing lands and then settles on its own.
   */
  providerById(id: string) {
    return this.listing?.providers.find((p) => p.id === id) ?? null;
  }

  /** Only the harnesses whose binary is on that machine, the way fastpick's own menu does. */
  get harnesses() {
    return (this.listing?.harnesses ?? []).filter((h) => h.installed);
  }

  /**
   * The providers wired to this harness, in the order fastpick lists them, which is the
   * order of the config. A provider whose key file is missing is left in and marked: it is
   * a thing to go and fix, not a thing to hide.
   */
  providersFor(harnessId: string) {
    const harness = this.listing?.harnesses.find((h) => h.id === harnessId);
    if (!harness) return [];
    const byId = new Map((this.listing?.providers ?? []).map((p) => [p.id, p]));
    return harness.providers.flatMap((id) => {
      const provider = byId.get(id);
      return provider ? [provider] : [];
    });
  }
}

export const fastpick = new FastpickStore();
