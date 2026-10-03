/*
 * The local dictation models a core offers, and the rules for one added from a
 * link. The core downloads and checks them; the in-memory client reads the
 * same list, so the settings page shows the same rows on both.
 */

// Both supported hosts expose URL; contracts otherwise need no DOM or Node types.
declare const URL: new (value: string) => { protocol: string; username: string; password: string; hostname: string };

export type SpeechModelTier = 'fast' | 'balanced' | 'accurate';
export type SpeechBackend = 'whisper' | 'whistle' | 'nemotron';

export interface SpeechCatalogueModel {
  id: string;
  /** The primary file under speech/; Nemotron also holds decoder, joiner and tokens beside it. */
  file: string;
  name: string;
  /** Total model bytes, including every component of a multi-file model. */
  bytes: number;
  sha256: string;
  tier: SpeechModelTier;
  /** Absent on older cores and custom ggml files, which use whisper.cpp. */
  backend?: SpeechBackend;
  /** Incremental audio decoding, rather than repeated preview windows. */
  streaming?: boolean;
  /** Kept for existing configurations rather than offered as a main choice. */
  legacy?: boolean;
}

/**
 * Whistle provides compact batch decoding; Nemotron provides incremental decoding.
 * The multilingual ggml models come from huggingface.co/ggerganov/whisper.cpp, sizes and
 * digests from its file listing (2026-09-26). On an 11 s clip with 8 threads and
 * the language known, the loaded model answered in 0.43 s (base), 1.46 s (small)
 * and 7.5 s (large-v3-turbo): the encoder of a large model is what costs on a CPU.
 */
export const SPEECH_CATALOGUE: readonly SpeechCatalogueModel[] = [
  { id: 'whistle', file: 'whistle.cact', name: 'Whistle', bytes: 16919407, sha256: 'b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb', tier: 'fast', backend: 'whistle' },
  { id: 'nemotron-streaming', file: 'nemotron/encoder.int8.onnx', name: 'Nemotron 3.5 Streaming', bytes: 682215356, sha256: '012e9321373af99021415e0b0eb3ec827b4be3153be6f30d9b448fe65e896e68', tier: 'accurate', backend: 'nemotron', streaming: true },
  { id: 'base-q5_1', file: 'ggml-base-q5_1.bin', name: 'Whisper Base', bytes: 59707625, sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898', tier: 'fast', legacy: true },
  { id: 'small-q5_1', file: 'ggml-small-q5_1.bin', name: 'Whisper Small', bytes: 190085487, sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb', tier: 'balanced', legacy: true },
  { id: 'large-v3-turbo-q5_0', file: 'ggml-large-v3-turbo-q5_0.bin', name: 'Whisper Large v3 Turbo', bytes: 574041195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2', tier: 'accurate' },
];

export const SPEECH_DEFAULT_MODEL = 'nemotron-streaming';

/** A model added from a link is named by a digest of that link. */
export const SPEECH_CUSTOM_ID = /^custom-[a-f0-9]{12}$/;

export function isSpeechModelId(value: unknown): value is string {
  return typeof value === 'string' && (SPEECH_CATALOGUE.some(model => model.id === value) || SPEECH_CUSTOM_ID.test(value));
}

/** Why a link cannot be downloaded as a model, or null when it can. */
export function speechUrlProblem(value: unknown): string | null {
  const expected = 'speech.url must be an https:// link to a ggml Whisper model, without a user name or password, at most 2048 characters';
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || /\s/.test(value)) return expected;
  let url: InstanceType<typeof URL>;
  try { url = new URL(value); } catch { return expected; }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return expected;
  return null;
}
