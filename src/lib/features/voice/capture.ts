/**
 * Microphone plumbing.
 *
 * Nothing here runs at import, the same discipline as `whip/crack.ts`: the OS
 * permission prompt fires on the user's own click, at the moment they chose,
 * which is what the "test the microphone" button in Settings is for. Asking on
 * page load trains people to dismiss prompts; asking mid-utterance loses the
 * first one they actually wanted to make.
 *
 * The WebSpeech engine opens the microphone itself, so today this module is
 * only the test path. The recorder path (whisper-local, openai-compatible)
 * lands with the mobile phase and will capture here too.
 */

export function captureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

/**
 * Opens the microphone once and closes it immediately: the point is the OS
 * prompt and a named verdict, not audio. The error string is the platform's
 * own (NotAllowedError, NotFoundError, ...), quoted rather than translated,
 * because it is the searchable name of the actual problem.
 */
export async function testMicrophone(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!captureSupported()) return { ok: false, error: "getUserMedia unavailable" };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.name : String(e) };
  }
}
