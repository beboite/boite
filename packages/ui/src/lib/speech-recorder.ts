import { SPEECH_MAX_SECONDS } from '@boite/contracts';
import { strings } from './strings';
import workletUrl from './speech-worklet.js?url';

export function pcmWav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const word = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i); };
  word(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); word(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  word(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const sample = Math.max(-1, Math.min(1, samples[i]!)); view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true); }
  return bytes;
}
export function audioBase64(bytes: Uint8Array): string {
  let raw = '';
  for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(raw);
}
export function microphoneError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return strings.speech.denied;
    if (error.name === 'NotFoundError') return strings.speech.noMicrophone;
    if (error.name === 'NotReadableError') return strings.speech.microphoneBusy;
  }
  return error instanceof Error ? error.message : strings.speech.failed;
}

export class SpeechRecorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];
  private samples = 0;
  private disposed = false;
  private heard = false;
  private flush: (() => void) | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;

  async start(level: (value: number, seconds: number) => void, ended: () => void): Promise<void> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error(strings.speech.https);
    try {
      // Create/resume inside the gesture, including Safari's user activation window.
      this.context = new AudioContext();
      const resumed = this.context.resume();
      void resumed.catch(() => {});
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.disposed) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      await resumed;
      const context = this.context;
      if (!context) return;
      await context.audioWorklet.addModule(workletUrl);
      if (this.disposed) return;
      this.node = new AudioWorkletNode(context, 'boite-dictation');
      this.node.port.onmessage = event => {
        if (event.data === null) { this.flush?.(); return; }
        const remaining = Math.floor(context.sampleRate * SPEECH_MAX_SECONDS) - this.samples;
        if (remaining <= 0) return;
        const chunk = (event.data as Float32Array).slice(0, remaining);
        this.chunks.push(chunk);
        this.samples += chunk.length;
        let sum = 0;
        for (const sample of chunk) sum += sample * sample;
        const rms = Math.sqrt(sum / chunk.length);
        if (rms > 0.008) this.heard = true;
        level(Math.min(1, rms * 8), this.samples / context.sampleRate);
        if (this.samples >= context.sampleRate * SPEECH_MAX_SECONDS) ended();
      };
      stream.getTracks().forEach(track => { track.onended = ended; });
      this.source = context.createMediaStreamSource(stream);
      this.source.connect(this.node);
      this.node.connect(context.destination);
      this.deadline = setTimeout(ended, SPEECH_MAX_SECONDS * 1000);
    } catch (error) { this.dispose(); throw error; }
  }
  async stop(): Promise<Uint8Array> {
    const context = this.context;
    if (!context || this.disposed) throw new Error(strings.speech.failed);
    try {
      if (this.node) await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 250);
        this.flush = () => { clearTimeout(timer); resolve(); };
        this.node!.port.postMessage('flush');
      });
      this.stream?.getTracks().forEach(track => { track.onended = null; if (track.readyState !== 'ended') track.stop(); });
      this.node?.disconnect();
      if (!this.heard || this.samples < context.sampleRate * 0.2) throw new Error(strings.speech.silence);
      const length = Math.min(16000 * SPEECH_MAX_SECONDS, Math.floor(this.samples * 16000 / context.sampleRate));
      const offline = new OfflineAudioContext(1, length, 16000);
      const buffer = offline.createBuffer(1, this.samples, context.sampleRate);
      const data = buffer.getChannelData(0);
      let offset = 0;
      for (const chunk of this.chunks) { data.set(chunk, offset); offset += chunk.length; }
      const source = offline.createBufferSource(); source.buffer = buffer; source.connect(offline.destination); source.start();
      return pcmWav((await offline.startRendering()).getChannelData(0));
    } finally { this.dispose(); }
  }
  dispose(): void {
    this.disposed = true;
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
    this.stream?.getTracks().forEach(track => { track.onended = null; if (track.readyState !== 'ended') track.stop(); });
    this.node?.disconnect();
    this.source?.disconnect(); this.source = null;
    if (this.node) this.node.port.onmessage = null;
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => {});
    this.context = null; this.stream = null; this.node = null; this.chunks = []; this.flush?.(); this.flush = null;
  }
}
