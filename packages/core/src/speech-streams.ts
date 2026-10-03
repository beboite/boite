import { dirname } from 'node:path';
import { SPEECH_MAX_BYTES, type SpeechConfig, type SpeechStatus } from '@boite/contracts';
import type { SpeechLocal } from './speech-local.ts';
import { invalidParams, refused } from './errors.ts';

export interface SpeechJob { id: string; controller: AbortController }
interface Session extends SpeechJob { sequence: number; samples: number; busy: boolean; timer: ReturnType<typeof setTimeout> }
type SessionParams = { requestId: string; revision: string };
type AudioParams = SessionParams & { sequence: number; audio?: string };

/** Connection-scoped streams share the ordinary local decoder's reservation. */
export class SpeechStreams {
  expiresMs = 180_000;
  private sessions = new Map<string, Session>();
  constructor(
    private local: SpeechLocal,
    private jobs: Map<string, SpeechJob>,
    private config: () => SpeechConfig,
    private status: () => SpeechStatus,
    private decode: (value: unknown, short: boolean) => Uint8Array,
  ) {}

  private validate(params: SessionParams): void {
    if (!params || typeof params.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(params.requestId)) throw invalidParams('speech.requestId must be 1 to 64 letters, digits or hyphens');
    const status = this.status();
    if (params.revision !== status.revision) throw refused('speech: voice settings changed during recording; record again with the selected engine');
    if (!status.ready || !status.streaming) throw refused('speech: select and install Nemotron Streaming in Voice settings first');
  }

  async start(connection: string, params: SessionParams): Promise<{ ok: true }> {
    this.validate(params);
    if (this.jobs.size) throw refused('speech: another transcription is running; try again shortly');
    const controller = new AbortController();
    const session: Session = { id: params.requestId, controller, sequence: 0, samples: 0, busy: true, timer: setTimeout(() => controller.abort(), this.expiresMs) };
    this.jobs.set(connection, session); this.sessions.set(connection, session);
    controller.signal.addEventListener('abort', () => {
      clearTimeout(session.timer);
      if (this.jobs.get(connection) === session) { this.jobs.delete(connection); void this.local.native.stop(); }
      if (this.sessions.get(connection) === session) this.sessions.delete(connection);
    }, { once: true });
    const config = this.config();
    try {
      await this.local.native.ensure(this.local.nativeRuntime, dirname(this.local.modelFile(config)), controller.signal);
      controller.signal.throwIfAborted();
      await this.local.native.request('start', { language: config.language }, controller.signal);
      controller.signal.throwIfAborted();
      session.busy = false;
      return { ok: true };
    } catch (error) { controller.abort(); throw error; }
  }

  async chunk(connection: string, params: AudioParams, finish = false): Promise<{ text: string }> {
    this.validate(params);
    const session = this.sessions.get(connection);
    if (!session || session.id !== params.requestId) throw refused('speech: no active stream with this requestId on this connection');
    if (!Number.isSafeInteger(params.sequence) || params.sequence !== session.sequence) throw invalidParams(`speech.sequence must be ${session.sequence} for the next audio chunk`);
    if (session.busy) throw refused('speech: wait for the previous audio chunk to finish');
    if (!finish && params.audio === undefined) throw invalidParams('speech.audio is required for an audio chunk');
    const wav = params.audio === undefined ? null : this.decode(params.audio, true);
    if (!finish && wav && wav.length > 44 + 16000 * 2 * 2) throw invalidParams('speech.audio stream chunks must be at most two seconds');
    const samples = session.samples + (wav ? (wav.length - 44) / 2 : 0);
    if (44 + samples * 2 > SPEECH_MAX_BYTES) throw invalidParams('speech.audio stream must be at most 120 seconds in total');
    session.busy = true;
    try {
      const result = await this.local.native.request(finish ? 'finish' : 'chunk', { ...(wav ? { audio: params.audio } : {}) }, session.controller.signal);
      session.controller.signal.throwIfAborted();
      if (!result || typeof result.text !== 'string' || result.text.length > 32_000) throw refused('speech: native decoder returned an invalid transcript');
      session.samples = samples; session.sequence++;
      return { text: result.text.trim() };
    } catch (error) { session.controller.abort(); throw error; }
    finally {
      session.busy = false;
      if (finish) {
        clearTimeout(session.timer);
        if (this.sessions.get(connection) === session) this.sessions.delete(connection);
        if (this.jobs.get(connection) === session) this.jobs.delete(connection);
      }
    }
  }
}
