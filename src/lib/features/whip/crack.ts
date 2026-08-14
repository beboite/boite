import { logger } from "$lib/shared/services/logger.svelte";

/**
 * The crack, synthesised rather than sampled.
 *
 * OpenWhip ships five mp3s for this, ~250 KB the window would download to make
 * a noise most sessions never hear. A crack is a noise burst whose spectrum
 * collapses in under a fifth of a second, which WebAudio builds from a filter
 * sweep over one cached buffer: no asset, nothing in the bundle budget, and the
 * variation that the five files existed for comes from jittering the sweep.
 *
 * The context is built on the first crack, never at import: a whip only exists
 * after a click, so the gesture that unlocks audio has always happened by then.
 */

const DURATION = 0.19;

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;
/** One failure is enough; nothing here is worth logging once per crack. */
let broken = false;

function context(): AudioContext | null {
  if (broken) return null;
  if (ctx) return ctx;
  const Ctor =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext);
  if (!Ctor) {
    broken = true;
    return null;
  }
  try {
    ctx = new Ctor();
    return ctx;
  } catch (err) {
    broken = true;
    logger.warn("app", "whip: no audio context", String(err));
    return null;
  }
}

/** White noise, made once and re-read from a random offset on every crack. */
function noiseBuffer(audio: AudioContext): AudioBuffer {
  if (noise) return noise;
  const frames = Math.ceil(audio.sampleRate * 1.5);
  const buf = audio.createBuffer(1, frames, audio.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  noise = buf;
  return buf;
}

/**
 * @param volume 0..1, the peak of the burst.
 */
export function playCrack(volume = 0.35): void {
  const audio = context();
  if (!audio) return;
  // Suspended is the normal state after the OS or the browser parks the tab.
  if (audio.state === "suspended") void audio.resume().catch(() => {});

  try {
    const now = audio.currentTime;
    const src = audio.createBufferSource();
    src.buffer = noiseBuffer(audio);
    // Both jittered per crack, which is the whole difference between this and
    // one sample played on a loop.
    src.playbackRate.value = 0.85 + Math.random() * 0.4;
    const offset = Math.random() * (src.buffer.duration - DURATION);

    // The sweep is the crack: a bright snap that drops to a body in ~150ms.
    const band = audio.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 0.8;
    const top = 4800 + Math.random() * 2200;
    band.frequency.setValueAtTime(top, now);
    band.frequency.exponentialRampToValueAtTime(600, now + DURATION);

    // Nothing below this is a whip; it is the rumble of the raw noise.
    const cut = audio.createBiquadFilter();
    cut.type = "highpass";
    cut.frequency.value = 320;

    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(volume, 0.0001), now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + DURATION);

    src.connect(band).connect(cut).connect(gain).connect(audio.destination);
    src.start(now, offset, DURATION);
    src.stop(now + DURATION);
    src.onended = () => {
      src.disconnect();
      gain.disconnect();
    };
  } catch (err) {
    broken = true;
    logger.warn("app", "whip: crack failed", String(err));
  }
}

/** Frees the context with the overlay, so the experiment costs nothing off. */
export function closeCrackAudio(): void {
  if (!ctx) return;
  const audio = ctx;
  ctx = null;
  noise = null;
  void audio.close().catch(() => {});
}
