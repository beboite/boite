import { backend, workspace } from "$lib/backend";
import { logger } from "$lib/shared/services/logger.svelte";
import { CLI_PRESETS } from "./cliPresets";

// Whether each preset's executable resolves on the machine that will run it.
// Keyed by executable, not preset id, so two presets sharing a binary share one
// probe. The probe crosses the transport, so on a remote boite this answers for
// the server, never for the device holding the UI.
class CliDetection {
  found = $state<Record<string, boolean>>({});
  checking = $state(false);
  // Tells "not probed yet" apart from "probed and absent": the preset row shows
  // nothing until a sweep landed.
  probed = $state(false);
  // Which workspace the current answers describe. A boite switch invalidates
  // them all, so the editor re-runs the sweep instead of showing the last
  // machine's PATH.
  #probedFor: string | null = null;

  async ensure() {
    const target = workspace.activeBoiteId ?? "local";
    if (this.#probedFor === target) return;
    this.#probedFor = target;
    this.found = {};
    this.probed = false;
    await this.refreshAll();
  }

  async refreshAll() {
    if (this.checking) return;
    this.checking = true;
    try {
      await Promise.all(CLI_PRESETS.map((preset) => this.#probe(preset.executable)));
      this.probed = true;
    } finally {
      this.checking = false;
    }
  }

  async refreshOne(executable: string) {
    await this.#probe(executable);
    this.probed = true;
  }

  async #probe(executable: string) {
    try {
      this.found[executable] = await backend().shell.commandExists(executable);
    } catch (err) {
      logger.warn("settings", `command probe failed for ${executable}`, String(err));
      this.found[executable] = false;
    }
  }
}

export const cliDetection = new CliDetection();
