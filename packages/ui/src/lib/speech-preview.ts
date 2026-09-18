import type { Client } from './client';
import { audioBase64 } from './speech-recorder';

/** One preview at a time. Slow engines skip ticks instead of accumulating work. */
export class SpeechPreview {
  private pending: Promise<void> | null = null;
  private requestId: string | null = null;
  private stopped = false;

  constructor(
    private client: Client,
    private revision: string,
    private ontext: (text: string) => void,
    private onerror: (error: unknown) => void,
  ) {}

  update(snapshot: () => Promise<Uint8Array | null>): void {
    if (this.stopped || this.pending) return;
    this.pending = this.run(snapshot).finally(() => { this.pending = null; });
  }

  private async run(snapshot: () => Promise<Uint8Array | null>): Promise<void> {
    try {
      const audio = await snapshot();
      if (!audio || this.stopped) return;
      this.requestId = crypto.randomUUID();
      const result = await this.client.call('speech.transcribe', { requestId: this.requestId, revision: this.revision, audio: audioBase64(audio) });
      if (!this.stopped && result.text.trim()) this.ontext(result.text.trim());
    } catch (error) {
      if (!this.stopped) { this.stopped = true; this.onerror(error); }
    } finally { this.requestId = null; }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.requestId) await this.client.call('speech.cancel', { requestId: this.requestId }).catch(() => {});
    await this.pending;
  }
}
