/**
 * Speech out: the orchestrator's `aloud` line, and nothing else.
 *
 * The language boundary is drawn here, once. Everything Boite itself says
 * (chrome, buttons, errors, notifications) goes through `t()` and follows the
 * locale record. What the agent says is the agent's prose, in the user's
 * language, imposed by a line of its system prompt: it does not go through
 * `t()` and cannot. This module only ever speaks the second kind — the `aloud`
 * field of the orchestrator's last `say`. Never a tool call, never a worker's
 * output, never an error toast.
 *
 * The voice is explicit, never automatic: `speak` takes the exact voice name
 * the user picked in Settings and refuses when it cannot find it, instead of
 * falling back to whatever English voice the OS ships first.
 */

export function ttsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function listVoices(): SpeechSynthesisVoice[] {
  if (!ttsSupported()) return [];
  return window.speechSynthesis.getVoices();
}

/**
 * The voice list loads asynchronously on most engines: `getVoices()` answers
 * empty until `voiceschanged` fires. The settings page watches it so the
 * select fills in without a reload.
 */
export function watchVoices(onChange: () => void): () => void {
  if (!ttsSupported()) return () => {};
  window.speechSynthesis.addEventListener("voiceschanged", onChange);
  return () => window.speechSynthesis.removeEventListener("voiceschanged", onChange);
}

/** Whether this voice speaks the given app locale ("fr" matches "fr-FR"). */
export function voiceMatchesLocale(voice: SpeechSynthesisVoice, locale: string): boolean {
  return voice.lang.toLowerCase().startsWith(locale.toLowerCase());
}

/**
 * Speaks one line with the named voice. False when the engine or the voice is
 * missing, so the caller can tell silence from refusal.
 */
export function speak(text: string, voiceName: string): boolean {
  if (!ttsSupported()) return false;
  const voice = listVoices().find((v) => v.name === voiceName);
  if (!voice) return false;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  // Sent explicitly rather than deduced: the utterance language is the voice's
  // own, whatever the app locale says, because the text is the agent's prose.
  utterance.lang = voice.lang;
  window.speechSynthesis.speak(utterance);
  return true;
}

/** The single cut: stops mid-sentence and drops whatever was queued. */
export function stopSpeaking(): void {
  if (!ttsSupported()) return;
  window.speechSynthesis.cancel();
}
