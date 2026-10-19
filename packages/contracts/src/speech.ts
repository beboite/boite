import type { SpeechBackend, SpeechModelTier } from './speech-models.ts';

// ---------------------------------------------------------------------------
// RPC surface. `hello` must be the first frame on every connection.
// ---------------------------------------------------------------------------

export type SpeechEngine = 'local' | 'api';
export interface SpeechConfig {
  engine: SpeechEngine;
  language: string;
  apiProvider: 'groq' | 'openrouter';
  fallback: boolean;
  executable: string;
  modelPath: string;
  /**
   * The local model in use: a `SPEECH_CATALOGUE` id or the `custom-<12 hex>` of
   * one added from a link. `modelPath`, when set, wins over it. A `speech.configure`
   * that leaves it out keeps the current one.
   */
  model: string;
}
/** A local model this core offers or holds. */
export interface SpeechModel {
  id: string;
  kind: 'catalogue' | 'custom';
  /** The catalogue's name, or the file name of the link a custom model came from. */
  name: string;
  /** The catalogue size, or what a custom download holds; 0 while unknown. */
  bytes: number;
  /** Catalogue only. */
  tier?: SpeechModelTier;
  /** Custom only: the host it came from. The link itself stays on the core. */
  host?: string;
  installed: boolean;
  backend?: SpeechBackend;
  streaming?: boolean;
  /** Earlier catalogue choices kept for saved configurations, under Advanced. */
  legacy?: boolean;
}
export interface SpeechStatus {
  revision: string;
  engine: SpeechEngine;
  ready: boolean;
  localReady: boolean;
  groqKeySet: boolean;
  openrouterKeySet: boolean;
  installing: boolean;
  downloadedBytes: number;
  /** 0 while a link's server has not said how big the file is. */
  totalBytes: number;
  error: string | null;
  canInstallRuntime: boolean;
  /** The catalogue, then every model added from a link. */
  models: SpeechModel[];
  /** The model a running download is for, null when none runs. */
  downloading: string | null;
  /** The managed runtime predates the resident engine; `speech.install` fetches it again (8 MB). */
  runtimeOutdated: boolean;
  /** Incremental sessions are supported by the currently selected local model. */
  streaming?: boolean;
  /** Preview cadence advertised by the engine, in milliseconds. */
  previewIntervalMs?: number;
}
export const SPEECH_MAX_SECONDS = 120;
export const SPEECH_MAX_BYTES = 44 + 16000 * 2 * SPEECH_MAX_SECONDS;

export interface SpeechRpcMethods {
  'speech.status': { params: Record<string, never>; result: SpeechStatus };
  'speech.configure': { params: SpeechConfig & { groqKey?: string; openrouterKey?: string }; result: SpeechStatus };
  'speech.config': { params: Record<string, never>; result: SpeechConfig };
  /**
   * Downloads a model and activates it once it is complete and checked: `model`
   * names a catalogue entry, `url` an https link to a ggml Whisper file (no digest
   * is known for it, its header is checked instead). Neither means the active
   * model. The runtime comes along when this core needs it.
   */
  'speech.install': { params: { model?: string; url?: string }; result: SpeechStatus };
  'speech.installCancel': { params: Record<string, never>; result: SpeechStatus };
  /** Removes one downloaded model, or with no `model` the runtime and every managed model. */
  'speech.uninstall': { params: { model?: string }; result: SpeechStatus };
  /** A dictation is starting: load the local model now so the first request finds it ready. */
  'speech.warm': { params: Record<string, never>; result: { ok: true } };
  /**
   * PCM WAV, mono 16 kHz. Each connection may have one request in flight. Audio is never journalled.
   * `preview` marks a provisional window, which a local engine may decode faster and less exactly.
   * `language` passes back what a preview of the same recording heard, used when the configured
   * language is automatic, so the final request skips its own detection.
   */
  'speech.transcribe': { params: { requestId: string; revision: string; audio: string; preview?: boolean; language?: string }; result: { text: string; language?: string } };
  'speech.cancel': { params: { requestId: string }; result: { ok: true } };
  'speech.streamStart': { params: { requestId: string; revision: string }; result: { ok: true } };
  /** A bounded, non-overlapping PCM WAV chunk; sequence starts at zero. */
  'speech.streamChunk': { params: { requestId: string; revision: string; sequence: number; audio: string }; result: { text: string } };
  /** Drains the decoder and returns the entire transcript, including optional remaining audio. */
  'speech.streamFinish': { params: { requestId: string; revision: string; sequence: number; audio?: string }; result: { text: string } };
}
