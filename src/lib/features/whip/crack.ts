import { logger } from "$lib/shared/services/logger.svelte";
import type { WhipSound } from "$lib/types";

/**
 * The crack, synthesised by default and sampled when asked for.
 *
 * OpenWhip ships five mp3s for this, ~250 KB the window would download to make
 * a noise most sessions never hear. A crack is a noise burst whose spectrum
 * collapses in under a fifth of a second, which WebAudio builds from a filter
 * sweep over one cached buffer: no asset, nothing in the bundle budget, and the
 * variation that the five files existed for comes from jittering the sweep.
 * That is still what `synth` does and still what every session gets by default.
 *
 * `sampled` is the one concession: six cracks in one 34 KB sprite, fetched on
 * the first crack after the setting is picked rather than at import, so a mode
 * nobody selects costs exactly what it did before it existed. The fetch failing
 * is not worth a silent whip: the burst plays instead, and the mode falls back
 * for good.
 *
 * The context is built on the first crack, never at import: a whip only exists
 * after a click, so the gesture that unlocks audio has always happened by then.
 */

const DURATION = 0.19;
const SAMPLE_URL = "/sounds/whip-cracks.mp3";
/** Equal slices of the sprite; the 80 ms of silence sits at the end of each. */
const CRACKS = 6;
/** ±3 %. The burst needs a wider jitter; six different cracks do not. */
const SAMPLE_RATE_JITTER = 0.03;

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;
/** One failure is enough; nothing here is worth logging once per crack. */
let broken = false;

/** The decoded sample, and the in-flight decode that every crack awaits once. */
let sample: AudioBuffer | null = null;
let loading: Promise<AudioBuffer | null> | null = null;
/** A sample that could not be fetched or decoded: synth from here on. */
let sampleBroken = false;
/** Last sprite slice, so two cracks in a row are never the same recording. */
let lastCrack: number | null = null;

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
 * The sample, fetched and decoded once.
 *
 * Returns null rather than throwing: every caller's answer to a missing sample
 * is the same burst it would have played anyway.
 */
function loadSample(audio: AudioContext): Promise<AudioBuffer | null> {
  if (sample) return Promise.resolve(sample);
  if (sampleBroken) return Promise.resolve(null);
  loading ??= (async () => {
    try {
      const res = await fetch(SAMPLE_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const decoded = await audio.decodeAudioData(await res.arrayBuffer());
      sample = decoded;
      return decoded;
    } catch (err) {
      sampleBroken = true;
      logger.warn("app", "whip: sample unavailable, using the synth", String(err));
      return null;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** True for the sprite mode, including a settings row still stored as `meme`. */
export function isSampledSound(sound: WhipSound): boolean {
  return sound === "sampled" || sound === "meme";
}

/**
 * Next slice of the sprite, never the same one twice running.
 *
 * `roll` is 0..1 so a test can pin the pick without stubbing `Math.random`.
 */
export function pickCrack(last: number | null, count: number, roll: number): number {
  if (count <= 1) return 0;
  let i = Math.floor(roll * count);
  if (i >= count) i = count - 1;
  if (last !== null && i === last) i = (i + 1) % count;
  return i;
}

/**
 * Warms the sprite so the first crack is already the noise that was picked.
 *
 * Called by the overlay when the rope is thrown. Without it the first crack
 * of a session is the burst while the fetch is still in the air, which reads as
 * the setting not having taken.
 */
export async function primeCrackSound(sound: WhipSound): Promise<void> {
  if (!isSampledSound(sound) || sample || sampleBroken) return;
  const audio = context();
  if (!audio) return;
  await loadSample(audio);
}

/**
 * @param sound which noise to make; `sampled` falls back to the burst until
 *   the sprite is decoded, and for good if it never is.
 * @param volume 0..1, the peak of the burst.
 */
export function playCrack(sound: WhipSound = "synth", volume = 0.35): void {
  const audio = context();
  if (!audio) return;
  // Suspended is the normal state after the OS or the browser parks the tab.
  if (audio.state === "suspended") void audio.resume().catch(() => {});

  if (isSampledSound(sound)) {
    if (sample) {
      playSampled(audio, sample, volume);
      return;
    }
    // Not decoded yet: start it, and make the noise the burst can make now.
    // A crack that waited on a fetch would land after the flick it belongs to.
    if (!sampleBroken) void loadSample(audio);
  }

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

/**
 * One of the six cracks, never the same one twice running.
 *
 * The sprite is packed as equal slices with the silence between them sitting
 * at the end of each, so a random index is the whole pick.
 */
function playSampled(audio: AudioContext, buffer: AudioBuffer, volume: number): void {
  try {
    const src = audio.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = 1 - SAMPLE_RATE_JITTER + Math.random() * SAMPLE_RATE_JITTER * 2;
    const index = pickCrack(lastCrack, CRACKS, Math.random());
    lastCrack = index;
    const slice = buffer.duration / CRACKS;
    const gain = audio.createGain();
    gain.gain.value = Math.max(volume, 0.0001);
    src.connect(gain).connect(audio.destination);
    src.start(0, index * slice, slice);
    src.onended = () => {
      src.disconnect();
      gain.disconnect();
    };
  } catch (err) {
    sampleBroken = true;
    logger.warn("app", "whip: sample playback failed", String(err));
  }
}

/** Frees the context with the overlay, so the experiment costs nothing off. */
export function closeCrackAudio(): void {
  if (!ctx) return;
  const audio = ctx;
  ctx = null;
  noise = null;
  // Decoded against the context being closed, so it cannot outlive it. The
  // failure flags stay: a sample that 404s does so on the next context too.
  sample = null;
  loading = null;
  lastCrack = null;
  void audio.close().catch(() => {});
}
