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
      orchestrator: s.experimentOrchestrator,
      voice: s.experimentVoice,
    });
  } catch {
    // No runtime, or the Worker is the invalid placeholder.
  }
}
