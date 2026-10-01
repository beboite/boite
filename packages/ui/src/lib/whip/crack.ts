/**
 * Legacy's crack: six recordings in one 34 KB sprite, with the synthesized
 * burst as the fallback while the sprite decodes or if it never does.
 * The sprite is inlined in its own lazy chunk and decoded from memory, since
 * the shell's content policy refuses a fetch of the app's own origin.
 */
let audio: AudioContext | undefined;
let noise: AudioBuffer | undefined;
let sample: AudioBuffer | undefined;
let loading: Promise<void> | undefined;
let sampleBroken = false;
let lastCrack: number | null = null;

/** Equal slices of the sprite; the silence sits at the end of each. */
const CRACKS = 6;
const SAMPLE_RATE_JITTER = 0.03;
const VOLUME = 0.35;

/** Next slice, never the same recording twice running. `roll` is 0..1. */
export function pickCrack(last: number | null, count: number, roll: number): number {
  if (count <= 1) return 0;
  let index = Math.min(Math.floor(roll * count), count - 1);
  if (last !== null && index === last) index = (index + 1) % count;
  return index;
}

function loadSample(context: AudioContext): void {
  if (sample || sampleBroken || loading) return;
  loading = (async () => {
    try {
      const { default: url } = await import('./whip-cracks.mp3?inline');
      const binary = atob(url.slice(url.indexOf(',') + 1));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const decoded = await context.decodeAudioData(bytes.buffer);
      // Decoded against a context that closed meanwhile: useless to the next one.
      if (audio === context) sample = decoded;
    } catch { sampleBroken = true; }
    finally { loading = undefined; }
  })();
}

export function primeCrackSound(): void {
  if (!audio) {
    if (!window.AudioContext) return;
    try {
      audio = new AudioContext();
      noise = audio.createBuffer(1, Math.ceil(audio.sampleRate * 1.5), audio.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      void audio.resume().catch(() => {});
    } catch { closeCrackAudio(); return; }
  }
  loadSample(audio);
}

export function playCrack(): void {
  if (!audio || !noise) return;
  try {
    if (audio.state === 'suspended') void audio.resume().catch(() => {});
    if (sample) playSampled(audio, sample);
    else playSynth(audio, noise);
  } catch { closeCrackAudio(); }
}

function playSampled(context: AudioContext, buffer: AudioBuffer): void {
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = 1 - SAMPLE_RATE_JITTER + Math.random() * SAMPLE_RATE_JITTER * 2;
  const index = pickCrack(lastCrack, CRACKS, Math.random());
  lastCrack = index;
  const slice = buffer.duration / CRACKS;
  const gain = context.createGain();
  gain.gain.value = VOLUME;
  source.connect(gain).connect(context.destination);
  source.start(0, index * slice, slice);
  source.onended = () => { source.disconnect(); gain.disconnect(); };
}

function playSynth(context: AudioContext, buffer: AudioBuffer): void {
  const duration = 0.19;
  const now = context.currentTime;
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = 0.85 + Math.random() * 0.4;
  const band = context.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 0.8;
  band.frequency.setValueAtTime(4800 + Math.random() * 2200, now);
  band.frequency.exponentialRampToValueAtTime(600, now + duration);
  const cut = context.createBiquadFilter();
  cut.type = 'highpass';
  cut.frequency.value = 320;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(VOLUME, now + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  source.connect(band).connect(cut).connect(gain).connect(context.destination);
  source.start(now, Math.random() * (buffer.duration - duration), duration);
  source.stop(now + duration);
  source.onended = () => { source.disconnect(); band.disconnect(); cut.disconnect(); gain.disconnect(); };
}

export function closeCrackAudio(): void {
  const context = audio;
  audio = undefined;
  noise = undefined;
  sample = undefined;
  lastCrack = null;
  if (context) void context.close().catch(() => {});
}
