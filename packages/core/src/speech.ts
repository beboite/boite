import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';
import { SPEECH_DEFAULT_MODEL, SPEECH_MAX_BYTES, isSpeechModelId, speechUrlProblem, type SpeechConfig, type SpeechStatus } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, refused } from './errors.ts';
import { SpeechLocal, transcribeLocal, type SpeechTarget } from './speech-local.ts';
import { catalogueEntry, catalogueSpec, customId, customName, whisperHeaderProblem, type CustomRecord } from './speech-models.ts';
import { SpeechStreams, type SpeechJob } from './speech-streams.ts';
import { transcribeWhistle } from './speech-whistle.ts';

export const DEFAULT_SPEECH: SpeechConfig = { engine: 'local', language: '', apiProvider: 'groq', fallback: false, executable: '', modelPath: '', model: SPEECH_DEFAULT_MODEL };
type Credentials = { groqKey: string; openrouterKey: string };
type TranscribeParams = { requestId: string; revision: string; audio: string; preview?: boolean; language?: string };
const ENDPOINTS = {
  groq: { url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo' },
  openrouter: { url: 'https://openrouter.ai/api/v1/audio/transcriptions', model: 'openai/whisper-large-v3-turbo' },
};

/** Accept only the bounded PCM format produced by the recorder, before starting any work. */
export function decodeSpeechAudio(value: unknown, short = false): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(SPEECH_MAX_BYTES / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalidParams('speech.audio must be a base64 WAV of at most 120 seconds');
  const data = Buffer.from(value, 'base64');
  if (data.length < (short ? 46 : 3244) || data.length > SPEECH_MAX_BYTES || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 16) !== 'WAVEfmt ' || data.readUInt32LE(16) !== 16 || data.readUInt16LE(20) !== 1 || data.readUInt16LE(22) !== 1 || data.readUInt32LE(24) !== 16000 || data.readUInt32LE(28) !== 32000 || data.readUInt16LE(32) !== 2 || data.readUInt16LE(34) !== 16 || data.toString('ascii', 36, 40) !== 'data' || data.readUInt32LE(40) !== data.length - 44 || data.readUInt32LE(4) !== data.length - 8 || data.length % 2 !== 0) throw invalidParams('speech.audio must be mono, 16 kHz, 16-bit PCM WAV between 0.1 and 120 seconds');
  return data;
}

/** A link has no digest to check: its first bytes must be a Whisper model's header instead. */
function customTarget(record: CustomRecord): SpeechTarget {
  return {
    id: record.id,
    custom: record,
    spec: {
      url: record.url, bytes: null, sha256: null,
      check: head => { const problem = whisperHeaderProblem(head, record.name); if (problem) throw invalidParams(problem); },
    },
  };
}

export class SpeechStore {
  private revision = crypto.randomUUID();
  private removing = false;
  readonly local: SpeechLocal;
  private config: SpeechConfig = { ...DEFAULT_SPEECH };
  private keys: Credentials = { groqKey: '', openrouterKey: '' };
  private loadError: string | null = null;
  private readonly running = new Map<string, SpeechJob>();
  readonly streams: SpeechStreams;
  private readonly file: string;
  constructor(private readonly core: Core) {
    this.local = new SpeechLocal(core);
    this.streams = new SpeechStreams(this.local, this.running, () => this.get(), () => this.status(), decodeSpeechAudio);
    this.file = join(core.dataDir, 'speech.json');
    if (existsSync(this.file)) {
      try {
        const saved = JSON.parse(readFileSync(this.file, 'utf8'));
        this.validate(saved);
        // A speech.json from before the model choice holds Whisper Small, the one model it could have.
        this.config = this.publicConfig({ ...saved, model: saved.model ?? 'small-q5_1' });
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
    const backend = this.config.modelPath ? undefined : catalogueEntry(this.config.model)?.backend;
    const localReady = this.local.ready(this.config.executable, this.local.modelFile(this.config), this.config.modelPath ? undefined : this.config.model);
    const groqKeySet = this.keys.groqKey.length > 0;
    const openrouterKeySet = this.keys.openrouterKey.length > 0;
    return {
      revision: this.revision, engine: this.config.engine,
      // Another model may download while this one dictates; only a runtime being replaced stops it.
      ready: this.loadError === null && (this.config.engine === 'local' ? localReady && !this.removing && !this.local.updatingRuntimeFor(this.config.modelPath ? undefined : this.config.model) :this.config.apiProvider === 'groq' ? groqKeySet : openrouterKeySet),
      localReady, groqKeySet, openrouterKeySet,
      installing: this.local.installing, downloadedBytes: this.local.downloadedBytes, totalBytes: this.local.totalBytes,
      error: this.loadError ?? this.local.error, canInstallRuntime: this.local.canInstallModel(this.config.model),
      models: this.local.models.list(), downloading: this.local.downloading, runtimeOutdated: !backend && this.local.runtimeOutdated(),
      streaming: this.config.engine === 'local' && backend === 'nemotron',
      previewIntervalMs: this.config.engine === 'api' ? 2500 : backend === 'whistle' ? 1000 : 1500,
    };
  }
  private publicConfig(p: SpeechConfig): SpeechConfig { return { engine: p.engine, language: p.language, apiProvider: p.apiProvider, fallback: p.fallback, executable: p.executable, modelPath: p.modelPath, model: p.model }; }
  private validate(p: Omit<SpeechConfig, 'model'> & { model?: string } & Partial<Credentials>): void {
    if (!p || !['local', 'api'].includes(p.engine) || !['groq', 'openrouter'].includes(p.apiProvider) || typeof p.fallback !== 'boolean') throw invalidParams('speech: expected engine local/api, provider groq/openrouter and boolean fallback');
    if (typeof p.language !== 'string' || !/^([a-z]{2})?$/.test(p.language)) throw invalidParams('speech.language must be empty for detection or a two-letter language code');
    for (const field of ['executable', 'modelPath'] as const) if (typeof p[field] !== 'string' || p[field].length > 4096 || (p[field] && !isAbsolute(p[field]))) throw invalidParams(`speech.${field} must be empty or an absolute path on this core`);
    for (const field of ['groqKey', 'openrouterKey'] as const) if (p[field] !== undefined && (typeof p[field] !== 'string' || p[field]!.length > 512 || /\s/.test(p[field]!))) throw invalidParams(`speech.${field} must be a key without whitespace, or empty to remove it`);
    if (p.model !== undefined && !isSpeechModelId(p.model)) throw invalidParams(`speech.model must be one of ${this.catalogueIds()} or custom-<12 hex>`);
  }
  private catalogueIds(): string { return this.local.models.list().filter(model => model.kind === 'catalogue').map(model => model.id).join(', '); }
  configure(p: Omit<SpeechConfig, 'model'> & { model?: string } & Partial<Credentials>): SpeechStatus {
    this.validate(p);
    const model = p?.model ?? this.config.model;
    if (model !== this.config.model && !catalogueEntry(model) && !this.local.models.custom(model)) throw invalidParams(`speech.model: ${model} is not a model on this core; add it from a link first`);
    return this.save({ ...this.publicConfig({ ...p, model }) }, { groqKey: p.groqKey ?? this.keys.groqKey, openrouterKey: p.openrouterKey ?? this.keys.openrouterKey });
  }
  private save(config: SpeechConfig, keys: Credentials): SpeechStatus {
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ ...config, ...keys }), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
    const before = this.config;
    // A recording made under other settings is refused; the loaded model follows the choice.
    this.revision = crypto.randomUUID();
    for (const job of this.running.values()) job.controller.abort();
    if (before.engine !== config.engine || before.model !== config.model || before.modelPath !== config.modelPath || before.executable !== config.executable) void this.local.server.stop();
    if (before.engine !== config.engine || before.model !== config.model || before.modelPath !== config.modelPath) void this.local.native.stop();
    this.config = config;
    this.keys = keys;
    this.loadError = null;
    return this.status();
  }
  /** A finished download becomes the model in use; a path set by hand gives way to it. */
  private activate(id: string): void {
    this.save({ ...this.config, model: id, modelPath: '' }, { ...this.keys });
  }
  install(p: { model?: string; url?: string } = {}): SpeechStatus {
    if (this.running.size || this.removing) throw refused('speech: wait for the current operation to finish before installing');
    if (!p || typeof p !== 'object') throw invalidParams('speech.install takes { model } or { url }');
    if (p.model !== undefined && p.url !== undefined) throw invalidParams('speech.install takes either model or url, not both');
    let target: SpeechTarget;
    if (p.url !== undefined) {
      const problem = speechUrlProblem(p.url);
      if (problem) throw invalidParams(problem);
      const url = new URL(p.url);
      const id = customId(p.url);
      target = customTarget(this.local.models.custom(id) ?? { id, url: p.url, name: customName(url), host: url.hostname, bytes: 0 });
    } else {
      const id = p.model ?? this.config.model;
      if (!isSpeechModelId(id)) throw invalidParams(`speech.model must be one of ${this.catalogueIds()} or custom-<12 hex>`);
      const entry = catalogueEntry(id);
      const custom = entry ? null : this.local.models.custom(id);
      if (entry) target = { id, spec: catalogueSpec(entry) };
      else if (custom) target = customTarget(custom);
      else throw invalidParams(`speech.model: ${id} is not a model on this core; add it from a link first`);
    }
    if (!this.local.start(target, id => this.activate(id))) this.activate(target.id);
    return this.status();
  }
  async uninstall(p: { model?: string } = {}): Promise<SpeechStatus> {
    if (this.running.size || this.removing) throw refused('speech: wait for the current operation to finish before removing the model');
    const model = p?.model;
    if (model !== undefined && !isSpeechModelId(model)) throw invalidParams(`speech.model must be one of ${this.catalogueIds()} or custom-<12 hex>`);
    this.removing = true;
    try {
      await this.local.remove(model);
      // The model in use went away: another one already here takes over, else a link's row falls back to the default.
      if (model !== undefined && model === this.config.model) {
        const next = this.local.models.list().find(entry => entry.installed)?.id ?? (catalogueEntry(model) ? model : SPEECH_DEFAULT_MODEL);
        if (next !== model) this.save({ ...this.config, model: next }, { ...this.keys });
      }
      return this.status();
    } finally { this.removing = false; }
  }
  /** Loads the configured model in the background; a failure is for the request that follows to report. */
  warm(): { ok: true } {
    if (this.config.engine !== 'local' || this.removing || this.local.installing || !this.status().ready) return { ok: true };
    const backend = this.config.modelPath ? undefined : catalogueEntry(this.config.model)?.backend;
    if (backend === 'nemotron') {
      void this.local.native.ensure(this.local.nativeRuntime, dirname(this.local.modelFile(this.config))).catch(() => {});
      return { ok: true };
    }
    if (backend === 'whistle') return { ok: true };
    const command = this.local.serverCommand(this.config.executable);
    if (command) void this.local.server.ensure(command, this.local.modelFile(this.config)).catch(() => {});
    return { ok: true };
  }
  cancel(connection: string, id?: string): void {
    const job = this.running.get(connection);
    if (job && (id === undefined || job.id === id)) job.controller.abort();
  }
  async close(): Promise<void> {
    for (const job of this.running.values()) job.controller.abort();
    await this.local.cancel();
    await this.local.server.stop();
    await this.local.native.stop();
  }
  async transcribe(connection: string, p: TranscribeParams): Promise<{ text: string; language?: string }> {
    if (!p || typeof p.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(p.requestId)) throw invalidParams('speech.requestId must be 1 to 64 letters, digits or hyphens');
    if (p.preview !== undefined && typeof p.preview !== 'boolean') throw invalidParams('speech.preview must be a boolean');
    if (p.language !== undefined && (typeof p.language !== 'string' || p.language.length > 24 || !/^[a-z]+( [a-z]+)*$/.test(p.language))) throw invalidParams('speech.language must be the language a preview returned, in lowercase letters');
    if (this.running.has(connection) || this.running.size >= 2 || (this.config.engine === 'local' && this.running.size > 0)) throw refused('speech: another transcription is running; try again shortly');
    if (this.removing || !this.status().ready) throw refused('speech: configure the selected engine in Voice settings first');
    if (p.revision !== this.revision) throw refused('speech: voice settings changed during recording; record again with the selected engine');
    const audio = decodeSpeechAudio(p.audio);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
    this.running.set(connection, { id: p.requestId, controller });
    const config = this.get(), keys = { ...this.keys };
    try {
      let result: { text: string; language?: string };
      const backend = config.modelPath ? undefined : catalogueEntry(config.model)?.backend;
      if (config.engine === 'local' && backend === 'whistle') {
        result = await transcribeWhistle(this.core, this.local, audio, config.language || p.language || '', signal);
      } else if (config.engine === 'local' && backend === 'nemotron') {
        await this.local.native.ensure(this.local.nativeRuntime, dirname(this.local.modelFile(config)), signal);
        result = await this.local.native.request('transcribe', { audio: p.audio, language: config.language }, signal);
      } else if (config.engine === 'local') {
        result = await transcribeLocal(this.core, this.local, audio, {
          executable: config.executable,
          model: this.local.modelFile(config),
          // A configured language wins; else what a preview of this recording heard, else detection.
          language: config.language || p.language || 'auto',
          preview: p.preview === true,
        }, signal);
      } else {
        let text: string;
        try { text = await this.api(config.apiProvider, audio, config, keys, signal); }
        catch (error) {
          signal.throwIfAborted();
          const second = config.apiProvider === 'groq' ? 'openrouter' : 'groq';
          if (!config.fallback || !keys[second === 'groq' ? 'groqKey' : 'openrouterKey']) throw error;
          text = await this.api(second, audio, config, keys, signal);
        }
        result = { text };
      }
      signal.throwIfAborted();
      if (!result || typeof result.text !== 'string' || result.text.length > 100_000) throw refused('speech: decoder returned an invalid transcript');
      return { ...result, text: result.text.trim() };
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
  core.router.register('speech.install', p => core.speech.install(p));
  core.router.register('speech.installCancel', async () => { await core.speech.local.cancel(); return core.speech.status(); });
  core.router.register('speech.uninstall', p => core.speech.uninstall(p));
  core.router.register('speech.warm', () => core.speech.warm());
  core.router.register('speech.transcribe', (p, ctx) => core.speech.transcribe(ctx.connection.id, p));
  core.router.register('speech.streamStart', (p, ctx) => core.speech.streams.start(ctx.connection.id, p));
  core.router.register('speech.streamChunk', (p, ctx) => core.speech.streams.chunk(ctx.connection.id, p));
  core.router.register('speech.streamFinish', (p, ctx) => core.speech.streams.chunk(ctx.connection.id, p, true));
  core.router.register('speech.cancel', (p, ctx) => { if (!p || typeof p.requestId !== 'string') throw invalidParams('speech.requestId is required'); core.speech.cancel(ctx.connection.id, p.requestId); return { ok: true }; });
}
