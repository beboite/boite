import { secureId } from '../secure-id';
/** Voice input: its configuration, the local models, their downloads and a transcription. */
import { RpcErrorCode, SPEECH_CATALOGUE, SPEECH_DEFAULT_MODEL, isSpeechModelId, speechUrlProblem, type SpeechModel, type SpeechStatus } from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';

/** The catalogue as the fake core first holds it, with the default model installed. */
export function fakeSpeechModels(): SpeechModel[] {
  return SPEECH_CATALOGUE.map(entry => ({ id: entry.id, kind: 'catalogue', name: entry.name, bytes: entry.bytes, tier: entry.tier, installed: entry.id === SPEECH_DEFAULT_MODEL, ...(entry.backend ? { backend: entry.backend } : {}), ...(entry.streaming ? { streaming: true } : {}) }));
}

/** What a fake link weighs once its server answers: a large-v3-turbo at q8_0. */
const CUSTOM_BYTES = 874188075;
/** One simulated download per fake core, advanced by a timer. */
const downloads = new WeakMap<FakeContext, ReturnType<typeof setInterval>>();
const streams = new WeakMap<FakeContext, { id: string; sequence: number }>();

const invalid = (message: string) => new RpcFailure({ code: RpcErrorCode.InvalidParams, message });
const refused = (message: string) => new RpcFailure({ code: RpcErrorCode.Refused, message });

/** A stable id per link, the shape the core gives it. */
function customId(url: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const char of url) hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0)!)) * 0x100000001b3n);
  return `custom-${hash.toString(16).padStart(16, '0').slice(0, 12)}`;
}

function snapshot(ctx: FakeContext): SpeechStatus {
  settle(ctx);
  return { ...ctx.speechStatus, models: ctx.speechStatus.models.map(model => ({ ...model })) };
}

/** The ready flags follow the chosen engine and whether its model is here. */
function settle(ctx: FakeContext): void {
  const status = ctx.speechStatus;
  status.localReady = ctx.speech.modelPath !== '' || status.models.some(model => model.id === ctx.speech.model && model.installed);
  status.engine = ctx.speech.engine;
  status.streaming = ctx.speech.engine === 'local' && !ctx.speech.modelPath && ctx.speech.model === 'nemotron-streaming';
  status.previewIntervalMs = ctx.speech.engine === 'api' ? 2500 : ctx.speech.model === 'whistle' ? 1000 : 1500;
  status.ready = ctx.speech.engine === 'local' ? status.localReady : ctx.speech.apiProvider === 'groq' ? status.groqKeySet : status.openrouterKeySet;
}

function activate(ctx: FakeContext, id: string): void {
  if (ctx.speech.model !== id || ctx.speech.modelPath) ctx.speechStatus.revision = secureId();
  ctx.speech = { ...ctx.speech, model: id, modelPath: '' };
  settle(ctx);
}

function stopDownload(ctx: FakeContext): void {
  clearInterval(downloads.get(ctx));
  downloads.delete(ctx);
  const status = ctx.speechStatus;
  const id = status.downloading;
  status.installing = false;
  status.downloading = null;
  // A link that never finished leaves no row, as on the core.
  status.models = status.models.filter(model => model.kind !== 'custom' || model.installed || model.id !== id);
}

export function speechMethods(ctx: FakeContext) {
  return {
    'speech.config': async () => ({ ...ctx.speech }),
    'speech.status': async () => snapshot(ctx),
    'speech.configure': async (params) => {
      const p = params;
      const model = p.model ?? ctx.speech.model;
      if (!isSpeechModelId(model)) throw invalid(`speech.model must be one of ${SPEECH_CATALOGUE.map(model => model.id).join(', ')} or custom-<12 hex>`);
      if (model !== ctx.speech.model && !ctx.speechStatus.models.some(entry => entry.id === model)) throw invalid(`speech.model: ${model} is not a model on this core; add it from a link first`);
      ctx.speech = { engine: p.engine, language: p.language, apiProvider: p.apiProvider, fallback: p.fallback, executable: p.executable, modelPath: p.modelPath, model };
      if (p.groqKey !== undefined) ctx.speechStatus.groqKeySet = !!p.groqKey;
      if (p.openrouterKey !== undefined) ctx.speechStatus.openrouterKeySet = !!p.openrouterKey;
      ctx.speechStatus.revision = secureId();
      streams.delete(ctx); ctx.speechRequests.clear();
      settle(ctx);
      return snapshot(ctx);
    },
    'speech.install': async (params) => {
      const status = ctx.speechStatus;
      if (status.installing) throw refused('speech: a download is already running');
      if (params.model !== undefined && params.url !== undefined) throw invalid('speech.install takes either model or url, not both');
      let id: string;
      if (params.url !== undefined) {
        const problem = speechUrlProblem(params.url);
        if (problem) throw invalid(problem);
        const url = new URL(params.url);
        const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '') || url.hostname;
        // A Hugging Face page instead of its file fails the header check, as it does on the core.
        if (url.pathname.includes('/blob/')) {
          status.error = `speech.url: ${name} is a web page, not the file itself (on Hugging Face, use the resolve link); expected a whisper.cpp ggml model such as ggml-base-q5_1.bin`;
          return snapshot(ctx);
        }
        id = customId(params.url);
        if (!status.models.some(model => model.id === id)) status.models.push({ id, kind: 'custom', name, bytes: 0, host: url.hostname, installed: false });
      } else {
        id = params.model ?? ctx.speech.model;
        if (!status.models.some(model => model.id === id)) throw invalid(`speech.model: ${id} is not a model on this core; add it from a link first`);
      }
      const model = status.models.find(entry => entry.id === id)!;
      status.error = null;
      if (model.installed) { activate(ctx, id); return snapshot(ctx); }
      status.installing = true;
      status.downloading = id;
      status.downloadedBytes = 0;
      status.totalBytes = model.kind === 'custom' ? 0 : model.bytes;
      let ticks = 0;
      downloads.set(ctx, setInterval(() => {
        ticks += 1;
        // A link's size is known once its server answers.
        if (model.kind === 'custom' && ticks === 1) { model.bytes = CUSTOM_BYTES; status.totalBytes = CUSTOM_BYTES; }
        status.downloadedBytes = Math.min(status.totalBytes, status.downloadedBytes + Math.ceil(status.totalBytes / 40));
        if (status.totalBytes === 0 || status.downloadedBytes < status.totalBytes) return;
        model.installed = true;
        stopDownload(ctx);
        activate(ctx, id);
      }, 250));
      return snapshot(ctx);
    },
    'speech.installCancel': async () => {
      stopDownload(ctx);
      return snapshot(ctx);
    },
    'speech.uninstall': async (params) => {
      const status = ctx.speechStatus;
      if (params.model === undefined) {
        stopDownload(ctx);
        status.models = status.models.filter(model => model.kind === 'catalogue').map(model => ({ ...model, installed: false }));
      } else {
        if (status.downloading === params.model) stopDownload(ctx);
        status.models = status.models
          .filter(model => model.kind === 'catalogue' || model.id !== params.model)
          .map(model => (model.id === params.model ? { ...model, installed: false } : model));
        if (ctx.speech.model === params.model) {
          const next = status.models.find(model => model.installed)?.id ?? (params.model.startsWith('custom-') ? SPEECH_DEFAULT_MODEL : params.model);
          if (next !== params.model) activate(ctx, next);
        }
      }
      status.error = null;
      settle(ctx);
      return snapshot(ctx);
    },
    'speech.warm': async () => ({ ok: true }),
    'speech.cancel': async (params) => {
      ctx.speechRequests.delete(params.requestId);
      if (streams.get(ctx)?.id === params.requestId) streams.delete(ctx);
      return { ok: true };
    },
    'speech.streamStart': async (params) => {
      settle(ctx);
      if (params.revision !== ctx.speechStatus.revision) throw refused('Voice settings changed during recording');
      if (!ctx.speechStatus.ready || !ctx.speechStatus.streaming) throw refused('Select and install Nemotron Streaming first');
      if (ctx.speechRequests.size) throw refused('Another transcription is running');
      streams.set(ctx, { id: params.requestId, sequence: 0 });
      ctx.speechRequests.set(params.requestId, Symbol(params.requestId));
      return { ok: true };
    },
    'speech.streamChunk': async (params) => {
      const stream = streams.get(ctx);
      if (params.revision !== ctx.speechStatus.revision || stream?.id !== params.requestId) throw refused('No active stream with this requestId');
      if (params.sequence !== stream.sequence) throw invalid(`speech.sequence must be ${stream.sequence}`);
      stream.sequence++;
      return { text: 'Please add a test for this change.' };
    },
    'speech.streamFinish': async (params) => {
      const stream = streams.get(ctx);
      if (params.revision !== ctx.speechStatus.revision || stream?.id !== params.requestId) throw refused('No active stream with this requestId');
      if (params.sequence !== stream.sequence) throw invalid(`speech.sequence must be ${stream.sequence}`);
      streams.delete(ctx); ctx.speechRequests.delete(params.requestId);
      return { text: 'Please add a test for this change.' };
    },
    'speech.transcribe': async (params) => {
      const p = params;
      if (!ctx.speechStatus.ready) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Configure Voice first' });
      if (p.revision !== ctx.speechStatus.revision) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Voice settings changed during recording; record again with the selected engine' });
      if (ctx.speechRequests.size) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Another transcription is running; try again shortly' });
      const request = Symbol(p.requestId);
      ctx.speechRequests.set(p.requestId, request);
      await new Promise(resolve => setTimeout(resolve, p.preview ? 120 : 250));
      if (ctx.speechRequests.get(p.requestId) !== request) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Transcription cancelled' });
      ctx.speechRequests.delete(p.requestId);
      const text = 'Please add a test for this change.';
      return ctx.speech.engine === 'local' ? { text, language: ctx.speech.language || p.language || 'english' } : { text };
    },
  } satisfies Partial<FakeMethods>;
}
