class DictationProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(2048);
    this.used = 0;
    this.port.onmessage = () => {
      if (this.used) this.port.postMessage(this.samples.slice(0, this.used));
      this.used = 0;
      this.port.postMessage(null);
    };
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i];
      this.samples[this.used++] = value / channels.length;
      if (this.used === this.samples.length) {
        this.port.postMessage(this.samples);
        this.used = 0;
      }
    }
    // Outputs remain zero: the microphone is never played through the speakers.
    return true;
  }
}
registerProcessor('boite-dictation', DictationProcessor);
