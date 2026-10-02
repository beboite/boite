import { linuxShell } from './shell-platform';
import { strings } from './strings';

/** Use the same input and processing for the settings meter and dictation. */
export function microphoneConstraints(deviceId = ''): MediaStreamConstraints {
  return { audio: {
    channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  } };
}

export function microphoneContext(): AudioContext {
  if (linuxShell()) throw new Error(strings.speech.linux);
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error(strings.speech.https);
  // Capture needs a clock but never plays through the speakers.
  const options: AudioContextOptions & { sinkId?: { type: 'none' } } =
    'setSinkId' in AudioContext.prototype ? { sinkId: { type: 'none' } } : {};
  return new AudioContext(options);
}

/** A local level meter: no recording buffer, worklet, upload or transcription. */
export class MicrophoneMonitor {
  #context: AudioContext | null = null;
  #stream: MediaStream | null = null;
  #source: MediaStreamAudioSourceNode | null = null;
  #analyser: AnalyserNode | null = null;
  #frame = 0;
  #disposed = false;

  async start(deviceId: string, level: (value: number) => void, ended: () => void): Promise<void> {
    try {
      const context = microphoneContext();
      this.#context = context;
      const resumed = context.resume();
      void resumed.catch(() => {});
      const stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(deviceId));
      if (this.#disposed) { stream.getTracks().forEach(track => track.stop()); return; }
      this.#stream = stream;
      await resumed;
      if (this.#disposed) return;
      stream.getTracks().forEach(track => { track.onended = ended; });
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      this.#source = source;
      this.#analyser = analyser;
      const samples = new Float32Array(analyser.fftSize);
      const sample = () => {
        if (this.#disposed) return;
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const value of samples) sum += value * value;
        level(Math.min(1, Math.sqrt(sum / samples.length) * 8));
        this.#frame = requestAnimationFrame(sample);
      };
      sample();
    } catch (error) { this.dispose(); throw error; }
  }

  dispose(): void {
    this.#disposed = true;
    cancelAnimationFrame(this.#frame);
    this.#stream?.getTracks().forEach(track => { track.onended = null; if (track.readyState !== 'ended') track.stop(); });
    this.#source?.disconnect();
    this.#analyser?.disconnect();
    if (this.#context && this.#context.state !== 'closed') void this.#context.close().catch(() => {});
    this.#context = null; this.#stream = null; this.#source = null; this.#analyser = null;
  }
}
