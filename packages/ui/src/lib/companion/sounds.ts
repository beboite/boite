/*
 * The companion's chimes, made on the spot with Web Audio: a few soft sine
 * notes each, nothing recorded, nothing to license. Settings, Companion
 * switches them off.
 */

export type Cue = 'open' | 'done' | 'call' | 'remind' | 'error';

/** Each note: frequency in hertz, start and length in seconds. */
const NOTES: Record<Cue, [number, number, number][]> = {
  open: [[660, 0, 0.09], [990, 0.06, 0.14]],
  done: [[784, 0, 0.14], [1175, 0.11, 0.26]],
  call: [[880, 0, 0.11], [1109, 0.15, 0.11], [880, 0.3, 0.16]],
  remind: [[1047, 0, 0.2], [1319, 0.2, 0.2], [1568, 0.4, 0.36]],
  error: [[392, 0, 0.16], [311, 0.13, 0.3]]
};

let context: AudioContext | null = null;

/**
 * A webview keeps Web Audio muted until the page is used: the first click on
 * the companion opens it, so a chime can later ring without one.
 */
export function unlockSounds(): void {
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume();
  } catch {
    /* no audio output */
  }
}

export function playCue(cue: Cue, volume = 0.05): void {
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume();
    const start = context.currentTime + 0.02;
    for (const [frequency, offset, length] of NOTES[cue]) {
      const at = start + offset;
      const tone = context.createOscillator();
      tone.type = 'sine';
      tone.frequency.value = frequency;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(volume, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
      tone.connect(gain).connect(context.destination);
      tone.start(at);
      tone.stop(at + length + 0.03);
    }
  } catch {
    /* no audio output: the companion stays silent */
  }
}
