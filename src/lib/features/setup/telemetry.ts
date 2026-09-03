import { backend } from "$lib/backend";
import { settings } from "$lib/features/settings/store.svelte";

/** Mode B snapshot of non-identifying settings. The queue drops it in Mode A. */
export async function reportSettingsSnapshot(): Promise<void> {
  try {
    const s = settings.state;
    await backend().telemetry.trackSettingsSnapshot({
      uiLanguage: s.locale,
      theme: s.themeMode,
      threadWorktrees: s.threadWorktrees,
      animations: s.motionMode,
      mcpYolo: s.mcpYolo,
      idleAutoclose: s.idleTimeoutMinutes > 0,
      // Two fields, one flag now: the orchestrator and its microphone were
      // folded into a single switch, and the payload's shape is the core's,
      // not this file's. Both read the folded flag rather than one of them
      // going silent, so a Mode B series does not break at this commit.
      orchestrator: s.experimentWorkspace,
      voice: s.experimentWorkspace,
    });
  } catch {
    // No runtime, or the Worker is the invalid placeholder.
  }
}
