import type { OrchestratorMessage } from "$lib/backend/types";
import { settings } from "$lib/features/settings/store.svelte";
import { windowFocused } from "$lib/app/focus.svelte";
import { AUTO_SEND_MS, shouldSpeak } from "./ptt.svelte";
import { speak, ttsSupported } from "./tts";

/**
 * What the voice experiment holds between components: the auto-send countdown
 * a transcription arms, and the ledger of which chat lines were already read
 * aloud. Capture itself lives in the button; speech itself lives in `tts.ts`;
 * the rules live in `ptt.svelte.ts` where the tests are.
 */
class VoiceStore {
  /** True while a transcription is counting down to send itself. */
  pendingSend = $state(false);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private spoken = new Set<string>();
  private primed = false;

  /**
   * Arms the countdown. Any interaction cancels it (the composer calls
   * `cancelAutoSend` on every keystroke), so a misread line never races the
   * hand correcting it.
   */
  armAutoSend(fire: () => void): void {
    this.cancelAutoSend();
    this.pendingSend = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pendingSend = false;
      fire();
    }, AUTO_SEND_MS);
  }

  cancelAutoSend(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingSend = false;
  }

  /**
   * Called with the visible conversation whenever it changes. The first call
   * only marks what is already there: history loaded on mount is for reading,
   * not for a surprise recital of last week's answers.
   */
  considerSpeaking(messages: OrchestratorMessage[]): void {
    if (!this.primed) {
      for (const m of messages) this.spoken.add(m.id);
      this.primed = true;
      return;
    }
    const enabled =
      settings.state.experimentVoice &&
      settings.state.voiceTts === "webspeech" &&
      ttsSupported();
    const voiceName = settings.state.voiceName;
    for (const m of messages) {
      if (this.spoken.has(m.id)) continue;
      this.spoken.add(m.id);
      const wanted = shouldSpeak(m, {
        enabled,
        voiceName,
        focused: windowFocused(),
        speakWhenUnfocused: settings.state.voiceSpeakWhenUnfocused,
      });
      if (wanted && m.aloud && voiceName) speak(m.aloud, voiceName);
    }
  }
}

export const voice = new VoiceStore();
