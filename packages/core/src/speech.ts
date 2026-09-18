import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { SPEECH_MAX_BYTES, type SpeechConfig, type SpeechStatus } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, refused } from './errors.ts';
import { SpeechLocal, transcribeLocal } from './speech-local.ts';

export const DEFAULT_SPEECH: SpeechConfig = { engine: 'local', language: '', apiProvider: 'groq', fallback: false, executable: '', modelPath: '' };
type Credentials = { groqKey: string; openrouterKey: string };
const ENDPOINTS = {
  groq: { url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo' },
  openrouter: { url: 'https://openrouter.ai/api/v1/audio/transcriptions', model: 'openai/whisper-large-v3-turbo' },
};

/** Accept only the bounded PCM format produced by the recorder, before starting any work. */
export function decodeSpeechAudio(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(SPEECH_MAX_BYTES / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalidParams('speech.audio must be a base64 WAV of at most 120 seconds');
  const data = Buffer.from(value, 'base64');
  if (data.length < 3244 || data.length > SPEECH_MAX_BYTES || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 16) !== 'WAVEfmt ' || data.readUInt32LE(16) !== 16 || data.readUInt16LE(20) !== 1 || data.readUInt16LE(22) !== 1 || data.readUInt32LE(24) !== 16000 || data.readUInt32LE(28) !== 32000 || data.readUInt16LE(32) !== 2 || data.readUInt16LE(34) !== 16 || data.toString('ascii', 36, 40) !== 'data' || data.readUInt32LE(40) !== data.length - 44 || data.readUInt32LE(4) !== data.length - 8 || data.length % 2 !== 0) throw invalidParams('speech.audio must be mono, 16 kHz, 16-bit PCM WAV between 0.1 and 120 seconds');
  return data;
}

export class SpeechStore {
  private revision = crypto.randomUUID();
  private removing = false;
  readonly local: SpeechLocal;
  private config: SpeechConfig = { ...DEFAULT_SPEECH };
  private keys: Credentials = { groqKey: '', openrouterKey: '' };
  private loadError: string | null = null;
  private readonly running = new Map<string, { id: string; controller: AbortController }>();
  private readonly file: string;
  constructor(private readonly core: Core) {
    this.local = new SpeechLocal(core.dataDir);
    this.file = join(core.dataDir, 'speech.json');
    if (existsSync(this.file)) {
      try {
        const saved = JSON.parse(readFileSync(this.file, 'utf8'));
        this.validate(saved);
        this.config = this.publicConfig(saved);
        this.keys = { groqKey: saved.groqKey ?? '', openrouterKey: saved.openrouterKey ?? '' };
      } catch {
        this.config = { ...DEFAULT_SPEECH };
        this.keys = { groqKey: '', openrouterKey: '' };
        this.loadError = 'speech.json: invalid voice configuration; choose an engine and save Voice settings to repair it';
      }
    }
  }
  get(): SpeechConfig { return { ...this.config }; }
  status(): SpeechStatus {
    const localReady = this.local.ready(this.config.executable, this.config.modelPath);
    const groqKeySet = this.keys.groqKey.length > 0;
    const openrouterKeySet = this.keys.openrouterKey.length > 0;
    return { revision: this.revision, engine: this.config.engine, ready: this.loadError === null && (this.config.engine === 'local' ? localReady && !this.local.installing : this.config.apiProvider === 'groq' ? groqKeySet : openrouterKeySet), localReady, groqKeySet, openrouterKeySet, installing: this.local.installing, downloadedBytes: this.local.downloadedBytes, totalBytes: this.local.totalBytes, error: this.loadError ?? this.local.error, canInstallRuntime: this.local.canInstallRuntime };
  }
  private publicConfig(p: SpeechConfig): SpeechConfig { return { engine: p.engine, language: p.language, apiProvider: p.apiProvider, fallback: p.fallback, executable: p.executable, modelPath: p.modelPath }; }
  private validate(p: SpeechConfig & Partial<Credentials>): void {
    if (!p || !['local', 'api'].includes(p.engine) || !['groq', 'openrouter'].includes(p.apiProvider) || typeof p.fallback !== 'boolean') throw invalidParams('speech: expected engine local/api, provider groq/openrouter and boolean fallback');
    if (typeof p.language !== 'string' || !/^([a-z]{2})?$/.test(p.language)) throw invalidParams('speech.language must be empty for detection or a two-letter language code');
    for (const field of ['executable', 'modelPath'] as const) if (typeof p[field] !== 'string' || p[field].length > 4096 || (p[field] && !isAbsolute(p[field]))) throw invalidParams(`speech.${field} must be empty or an absolute path on this core`);
    for (const field of ['groqKey', 'openrouterKey'] as const) if (p[field] !== undefined && (typeof p[field] !== 'string' || p[field]!.length > 512 || /\s/.test(p[field]!))) throw invalidParams(`speech.${field} must be a key without whitespace, or empty to remove it`);
  }
  configure(p: SpeechConfig & Partial<Credentials>): SpeechStatus {
    this.validate(p);
    const config = this.publicConfig(p);
    const keys = { groqKey: p.groqKey ?? this.keys.groqKey, openrouterKey: p.openrouterKey ?? this.keys.openrouterKey };
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ ...config, ...keys }), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
    this.revision = crypto.randomUUID();
    this.config = config;
    this.keys = keys;
    this.loadError = null;
    return this.status();
  }
  install(): SpeechStatus {
    if (this.running.size || this.removing) throw refused('speech: wait for the current operation to finish before installing');
    this.local.start(); return this.status();
  }
  async uninstall(): Promise<SpeechStatus> {
    if (this.running.size || this.removing) throw refused('speech: wait for the current operation to finish before removing the model');
    this.removing = true;
    try { await this.local.remove(); return this.status(); }
    finally { this.removing = false; }
  }
  cancel(connection: string, id?: string): void {
    const job = this.running.get(connection);
    if (job && (id === undefined || job.id === id)) job.controller.abort();
  }
  async close(): Promise<void> {
    for (const job of this.running.values()) job.controller.abort();
    await this.local.cancel();
  }
  async transcribe(connection: string, p: { requestId: string; revision: string; audio: string }): Promise<{ text: string }> {
    if (!p || typeof p.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(p.requestId)) throw invalidParams('speech.requestId must be 1 to 64 letters, digits or hyphens');
    if (this.running.has(connection) || this.running.size >= 2 || (this.config.engine === 'local' && this.running.size > 0)) throw refused('speech: another transcription is running; try again shortly');
    if (this.removing || !this.status().ready) throw refused('speech: configure the selected engine in Voice settings first');
    if (p.revision !== this.revision) throw refused('speech: voice settings changed during recording; record again with the selected engine');
    const audio = decodeSpeechAudio(p.audio);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
    this.running.set(connection, { id: p.requestId, controller });
    const config = this.get(), keys = { ...this.keys };
    try {
      let text: string;
      if (config.engine === 'local') text = await transcribeLocal(this.core, this.local, audio, config, signal);
      else {
        try { text = await this.api(config.apiProvider, audio, config, keys, signal); }
        catch (error) {
          signal.throwIfAborted();
          const second = config.apiProvider === 'groq' ? 'openrouter' : 'groq';
          if (!config.fallback || !keys[second === 'groq' ? 'groqKey' : 'openrouterKey']) throw error;
          text = await this.api(second, audio, config, keys, signal);
        }
      }
      signal.throwIfAborted();
      return { text: text.trim() };
    } catch (error) {
      if (signal.aborted) throw refused(controller.signal.aborted ? 'speech: transcription cancelled' : 'speech: transcription timed out');
      throw error;
    } finally { this.running.delete(connection); }
  }
  private async api(provider: 'groq' | 'openrouter', audio: Uint8Array, config: SpeechConfig, keys: Credentials, signal: AbortSignal): Promise<string> {
    const target = ENDPOINTS[provider];
    const headers: Record<string, string> = { Authorization: `Bearer ${provider === 'groq' ? keys.groqKey : keys.openrouterKey}` };
    let body: FormData | string;
    if (provider === 'openrouter') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ model: target.model, input_audio: { data: Buffer.from(audio).toString('base64'), format: 'wav' }, ...(config.language ? { language: config.language } : {}) });
    } else {
      body = new FormData();
      body.set('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'dictation.wav');
      body.set('model', target.model);
      body.set('response_format', 'json');
      if (config.language) body.set('language', config.language);
    }
    let response: Response;
    try { response = await fetch(target.url, { method: 'POST', headers, body, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]), redirect: 'error' }); }
    catch { signal.throwIfAborted(); throw refused(`speech: ${provider} could not be reached`); }
    if (!response.ok) {
      await response.body?.cancel();
      throw refused(`speech: ${provider} returned HTTP ${response.status}${response.status === 429 ? '; rate limit reached, try again later' : ''}`);
    }
    let result: unknown;
    try {
      if (!response.body) throw new Error();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 512_000) throw new Error();
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { signal.throwIfAborted(); throw refused(`speech: ${provider} returned an invalid transcript`); }
    if (!result || typeof result !== 'object' || !('text' in result) || typeof result.text !== 'string' || result.text.length > 100_000) throw refused(`speech: ${provider} returned an invalid transcript`);
    return result.text;
  }
}

export function registerSpeechMethods(core: Core): void {
  core.router.register('speech.status', () => core.speech.status());
  core.router.register('speech.config', () => core.speech.get());
  core.router.register('speech.configure', p => core.speech.configure(p));
  core.router.register('speech.install', () => core.speech.install());
  core.router.register('speech.installCancel', async () => { await core.speech.local.cancel(); return core.speech.status(); });
  core.router.register('speech.uninstall', () => core.speech.uninstall());
  core.router.register('speech.transcribe', (p, ctx) => core.speech.transcribe(ctx.connection.id, p));
  core.router.register('speech.cancel', (p, ctx) => { if (!p || typeof p.requestId !== 'string') throw invalidParams('speech.requestId is required'); core.speech.cancel(ctx.connection.id, p.requestId); return { ok: true }; });
}
