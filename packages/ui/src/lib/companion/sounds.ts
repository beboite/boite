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
  // A reminder is asked for, and may ring while the user looks elsewhere: twice over.
  remind: [[1047, 0, 0.2], [1319, 0.2, 0.2], [1568, 0.4, 0.36], [1047, 1.1, 0.2], [1319, 1.3, 0.2], [1568, 1.5, 0.5]],
  error: [[392, 0, 0.16], [311, 0.13, 0.3]]
};

/** Peak gain: soft cues for what the user is watching, a louder one for a reminder. */
const VOLUME: Record<Cue, number> = { open: 0.05, done: 0.05, call: 0.06, remind: 0.16, error: 0.05 };

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

export function playCue(cue: Cue, volume = VOLUME[cue]): void {
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
