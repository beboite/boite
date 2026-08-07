import { backend } from "$lib/backend";
import { FASTPICK_CMD } from "./combo";
import type { Backend } from "$lib/backend";
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
 *
 * In dynamic mode `backend()` is the local device, so that is the machine described, in
 * step with every other workspace-global probe (`Workspace.current`). A thread launched
 * into a remote project spawns on the boite instead (`launchShell` resolves the shell
 * against `platform.shellsFor(origin)`, `thread/api.ts`) and
 * resolves that machine's fastpick, which this listing is not about. Describing both at
 * once would take an origin at every read, and the readers may have none to give: opened
 * from the bar, the walk holds no project and resolves its target on the click that ends
 * it, and `threadAccent` asks `providerById` with a combo and nothing else.
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

  // The transport that answered, which is the machine these answers describe. Keyed on the
  // active boite id before, and that id names the remote whether or not anything crosses
  // the socket: `backend()` is the boite in `remote` mode and this device in `dynamic`, so
  // a workspace grafted onto boite A and a pure remote one on boite A shared a key while
  // describing two different machines. Flipping between them matched and returned early,
  // so the menu kept listing the other machine's harnesses, providers and models, and a
  // model picked from that list was not on the machine that spawned.
  //
  // The transport itself rather than a name for it: `Workspace.current()` owns the rule for
  // which machine answers, and a string rebuilt from mode and boite id here is that rule
  // written twice. A redial hands back a new instance and re-probes, which is right anyway:
  // a boite that went away and came back may have been updated.
  #answeredBy: Backend | null = null;
  // Whether that machine's listing was fetched. Separate from the transport, since a probe
  // adopts a machine without listing it.
  #listed = false;

  // Drops what another machine said, all of it. A switch leaves nothing of the previous one
  // on screen while the new probe is in flight: a stale listing reads as this machine's.
  #adopt(from: Backend): void {
    if (this.#answeredBy === from) return;
    this.#answeredBy = from;
    this.#listed = false;
    this.installed = null;
    this.version = null;
    this.cargoPresent = null;
    this.listing = null;
    this.models = {};
    this.modelsError = {};
    this.error = null;
    this.loading = false;
  }

  /** Probes and lists once per machine. Cheap to call on every menu open. */
  async ensure(): Promise<void> {
    this.#adopt(backend());
    if (this.#listed) return;
    await this.reload();
  }

  async reload(): Promise<void> {
    // Resolved once and asked twice, rather than `backend()` per call: a switch between the
    // two answers "installed" off one machine's PATH and lists the other machine's config.
    const from = backend();
    this.#adopt(from);
    this.#listed = true;
    this.listing = null;
    this.models = {};
    this.modelsError = {};
    this.error = null;
    this.loading = true;
    try {
      const installed = await from.shell.commandExists(FASTPICK_CMD);
      if (this.#answeredBy !== from) return;
      this.installed = installed;
      if (!installed) return;
      const listing = await from.fastpick.list();
      if (this.#answeredBy !== from) return;
      this.listing = listing;
    } catch (err) {
      // fastpick puts a usable sentence on stderr and the backend carries it through, so
      // this is worth showing rather than replacing with a generic failure.
      if (this.#answeredBy === from) this.error = String(err);
    } finally {
      // A workspace switch mid-flight leaves this answering the wrong machine, and the
      // reload it started owns the flag from then on.
      if (this.#answeredBy === from) this.loading = false;
    }
  }

  /**
   * That provider's models. Served from what was already fetched unless `refresh`, so
   * walking back and forth in the menu costs nothing.
   */
  async loadModels(providerId: string, refresh = false): Promise<void> {
    if (!refresh && this.models[providerId]) return;
    const from = backend();
    this.loadingModels = providerId;
    delete this.modelsError[providerId];
    try {
      const listing = await from.fastpick.list(providerId, refresh);
      // The map belongs to whichever machine `#adopt` last let in. A model list that
      // arrives after a switch is another machine's and is dropped.
      if (this.#answeredBy !== from) return;
      if (listing.models) this.models[providerId] = listing.models;
    } catch (err) {
      if (this.#answeredBy === from) this.modelsError[providerId] = String(err);
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
    const from = backend();
    this.#adopt(from);
    this.probing = true;
    try {
      const [version, cargo] = await Promise.all([
        from.fastpick.version(),
        from.shell.commandExists("cargo"),
      ]);
      if (this.#answeredBy !== from) return;
      this.version = version;
      this.cargoPresent = cargo;
      const had = this.installed;
      this.installed = version !== null;
      // A fastpick that was not there when the menu last looked has a config to list now.
      // A machine `#adopt` has just let in has none either, and `had` is null for it.
      if (this.installed && had !== true) {
        this.#listed = false;
        await this.ensure();
      }
    } finally {
      // Unguarded, unlike the flags above: nothing succeeds a probe the way a reload
      // succeeds a reload, so a switch mid-probe would leave the panel's button disabled
      // with nothing running behind it.
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
