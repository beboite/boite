import type { Client } from './client';
import { secureId } from './secure-id';
import { audioBase64 } from './speech-recorder';

/** One incremental upload at a time. Finish sends exactly the audio not yet acknowledged. */
export class SpeechStream {
  private id = secureId();
  private sequence = 0;
  private submitted = 0;
  private closed = false;
  private failure: unknown;
  private failed = false;
  private pending: Promise<void> | null = null;
  private ready: Promise<void>;

  constructor(private client: Client, private revision: string, private ontext: (text: string) => void, private onerror: (error: unknown) => void) {
    this.ready = client.call('speech.streamStart', { requestId: this.id, revision }).then(() => {}, error => this.fail(error));
  }
  private params() { return { requestId: this.id, revision: this.revision, sequence: this.sequence }; }
  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true; this.failure = error;
    if (!this.closed) this.onerror(error);
  }
  update(snapshot: () => Promise<Uint8Array | null>): void {
    if (this.closed || this.failed || this.pending) return;
    this.pending = this.run(snapshot).finally(() => { this.pending = null; });
  }
  private async run(snapshot: () => Promise<Uint8Array | null>): Promise<void> {
    try {
      await this.ready;
      if (this.closed || this.failed) return;
      const audio = await snapshot();
      if (this.closed || !audio) return;
      const result = await this.client.call('speech.streamChunk', { ...this.params(), audio: audioBase64(audio) });
      this.submitted += audio.length - 44; this.sequence++;
      if (!this.closed) this.ontext(result.text);
    } catch (error) { this.fail(error); }
  }
  async finish(audio: Uint8Array): Promise<string> {
    this.closed = true;
    await this.pending; await this.ready;
    if (this.failed) { await this.stop(); throw this.failure; }
    if (this.submitted > audio.length - 44) { await this.stop(); throw new Error('speech: streamed audio exceeds the recording'); }
    let remaining: Uint8Array | undefined;
    if (this.submitted < audio.length - 44) {
      remaining = new Uint8Array(audio.length - this.submitted);
      remaining.set(audio.subarray(0, 44)); remaining.set(audio.subarray(44 + this.submitted), 44);
      const header = new DataView(remaining.buffer);
      header.setUint32(4, remaining.length - 8, true); header.setUint32(40, remaining.length - 44, true);
    }
    try {
      const result = await this.client.call('speech.streamFinish', { ...this.params(), ...(remaining ? { audio: audioBase64(remaining) } : {}) });
      return result.text;
    } catch (error) { await this.stop(); throw error; }
  }
  async stop(): Promise<void> {
    this.closed = true;
    await this.client.call('speech.cancel', { requestId: this.id }).catch(() => {});
    await this.pending; await this.ready;
  }
}
