/** Legacy's synthesized crack, created only after the user throws a rope. */
let audio: AudioContext | undefined;
let noise: AudioBuffer | undefined;

export function primeCrackSound(): void {
  if (audio || !window.AudioContext) return;
  try {
    audio = new AudioContext();
    noise = audio.createBuffer(1, Math.ceil(audio.sampleRate * 1.5), audio.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    void audio.resume().catch(() => {});
  } catch { closeCrackAudio(); }
}

export function playCrack(): void {
  if (!audio || !noise) return;
  const duration = 0.19;
  const now = audio.currentTime;
  try {
    if (audio.state === 'suspended') void audio.resume().catch(() => {});
    const source = audio.createBufferSource();
    source.buffer = noise;
    source.playbackRate.value = 0.85 + Math.random() * 0.4;
    const band = audio.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 0.8;
    band.frequency.setValueAtTime(4800 + Math.random() * 2200, now);
    band.frequency.exponentialRampToValueAtTime(600, now + duration);
    const cut = audio.createBiquadFilter();
    cut.type = 'highpass';
    cut.frequency.value = 320;
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.35, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(band).connect(cut).connect(gain).connect(audio.destination);
    source.start(now, Math.random() * (noise.duration - duration), duration);
    source.stop(now + duration);
    source.onended = () => { source.disconnect(); band.disconnect(); cut.disconnect(); gain.disconnect(); };
  } catch { closeCrackAudio(); }
}

export function closeCrackAudio(): void {
  const context = audio;
  audio = undefined;
  noise = undefined;
  if (context) void context.close().catch(() => {});
}
