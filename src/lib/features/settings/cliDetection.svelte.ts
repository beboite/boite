import { backend } from "$lib/backend";
import { logger } from "$lib/shared/services/logger.svelte";
import { CLI_PRESETS } from "./cliPresets";
import type { Backend } from "$lib/backend";

// Whether each preset's executable resolves on the machine that will run it.
// Keyed by executable, not preset id, so two presets sharing a binary share one
// probe. The probe crosses the transport, so on a remote boite this answers for
// the server, never for the device holding the UI; in dynamic mode that
// transport is this device, the way every workspace-global probe is.
class CliDetection {
  found = $state<Record<string, boolean>>({});
  checking = $state(false);
  // Tells "not probed yet" apart from "probed and absent": the preset row shows
  // nothing until a sweep landed.
  probed = $state(false);
  // The transport that answered, which is the machine this PATH belongs to.
  // Keyed on the active boite id before, and that id names the remote whether or
  // not anything crosses the socket: `backend()` is the boite in `remote` mode
  // and this device in `dynamic`, so both modes against boite A shared a key
  // while describing two different machines. Flipping between them matched and
  // returned early, so a dynamic workspace turned pure remote kept showing the
  // local PATH, and the way back kept showing the server's. One record cannot
  // describe two PATHs at once, so it describes the one that was asked.
  #answeredBy: Backend | null = null;

  async ensure() {
    if (this.#answeredBy === backend()) return;
    this.found = {};
    this.probed = false;
    await this.refreshAll();
  }

  async refreshAll() {
    const from = backend();
    // A sweep already running for this machine is the one to wait on. A sweep
    // running for another one is not: its answers are about to be dropped, and
    // bowing out here left the switch with an empty map and nothing coming to
    // fill it.
    if (this.checking && this.#answeredBy === from) return;
    this.#answeredBy = from;
    this.checking = true;
    try {
      await Promise.all(CLI_PRESETS.map((preset) => this.#probe(from, preset.executable)));
      if (this.#answeredBy !== from) return;
      this.probed = true;
    } finally {
      // The sweep that owns the machine owns the flag. A late one clearing it
      // would stop the spinner over a sweep that is still running.
      if (this.#answeredBy === from) this.checking = false;
    }
  }

  async refreshOne(executable: string) {
    const from = backend();
    // One answer has nothing to join when the map belongs to another machine, or
    // to none yet. The sweep is what builds one, and it covers this executable.
    if (this.#answeredBy !== from) return this.ensure();
    await this.#probe(from, executable);
    this.probed = true;
  }

  // Asks the transport it was handed, never `backend()` again: a sweep is one
  // machine's PATH, and re-reading it per preset would split a switch across
  // both machines and leave a map neither of them would recognise.
  async #probe(from: Backend, executable: string) {
    try {
      const found = await from.shell.commandExists(executable);
      if (this.#answeredBy !== from) return;
      this.found[executable] = found;
    } catch (err) {
      logger.warn("settings", `command probe failed for ${executable}`, String(err));
      if (this.#answeredBy === from) this.found[executable] = false;
    }
  }
}

export const cliDetection = new CliDetection();
