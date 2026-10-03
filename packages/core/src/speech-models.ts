import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPEECH_CATALOGUE, SPEECH_CUSTOM_ID, type SpeechCatalogueModel, type SpeechModel } from '@boite/contracts';
import { invalidParams } from './errors.ts';
import { NEMOTRON_FILES } from './speech-artifacts.ts';

const CATALOGUE_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
/** large-v3 at f16 is 3.1 GB; nothing whisper.cpp loads on a CPU is bigger. */
export const CUSTOM_MAX_BYTES = 4 * 1024 ** 3;

/** What a download needs to know. A custom link has no known size or digest. */
export interface DownloadSpec {
  url: string;
  bytes: number | null;
  sha256: string | null;
  /** Called once with the first 48 bytes; throws when they are not what the file must be. */
  check?: (head: Uint8Array) => void;
}

/** A model added from a link, as `custom/<id>.json` keeps it beside `custom/<id>.bin`. */
export interface CustomRecord {
  id: string;
  url: string;
  name: string;
  host: string;
  bytes: number;
}

export function catalogueEntry(id: string): SpeechCatalogueModel | undefined {
  return SPEECH_CATALOGUE.find(model => model.id === id);
}

export function catalogueSpec(model: SpeechCatalogueModel): DownloadSpec {
  if (model.backend === 'whistle') return { url: 'https://huggingface.co/Cactus-Compute/whistle/resolve/b358ddadd89b7a713b5aa131f23032d3cca1b251/whistle.cact', bytes: model.bytes, sha256: model.sha256 };
  if (model.backend === 'nemotron') return NEMOTRON_FILES[0]!;
  return { url: `${CATALOGUE_BASE}${model.file}`, bytes: model.bytes, sha256: model.sha256 };
}

export function customId(url: string): string {
  return `custom-${createHash('sha256').update(url).digest('hex').slice(0, 12)}`;
}

/** The link's file name, readable and safe to show; the host when the path has none. */
export function customName(url: URL): string {
  let last = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  try { last = decodeURIComponent(last); } catch { /* keep it as written */ }
  const name = last.replace(/[^\w.\-() ]+/g, '').trim().slice(0, 80);
  return name || url.hostname;
}

/**
 * A whisper.cpp model starts with the ggml magic and the Whisper hyperparameters:
 * 1500 audio positions, 448 text positions, 80 or 128 mel bands. Anything else,
 * a web page, a GGUF language model, a VAD model, is refused before it is used.
 */
export function whisperHeaderProblem(head: Uint8Array, name: string): string | null {
  const refuse = (what: string) => `speech.url: ${name} ${what}; expected a whisper.cpp ggml model such as ggml-base-q5_1.bin`;
  if (head.length < 48) return refuse('is too short to be a model');
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const magic = view.getUint32(0, true);
  if (magic === 0x46554747) return refuse('is a GGUF file, which whisper.cpp does not load');
  if (magic !== 0x67676d6c) {
    const text = new TextDecoder().decode(head.subarray(0, 16)).trimStart().toLowerCase();
    return refuse(text.startsWith('<') ? 'is a web page, not the file itself (on Hugging Face, use the resolve link)' : 'does not start with the ggml magic');
  }
  const audioCtx = view.getInt32(8, true), textCtx = view.getInt32(24, true), mels = view.getInt32(40, true);
  if (audioCtx !== 1500 || textCtx !== 448 || (mels !== 80 && mels !== 128)) return refuse('is a ggml file but not a Whisper model');
  return null;
}

/** Which models this core offers and holds, and where each lives under `speech/`. */
export class SpeechModels {
  readonly customDir: string;
  constructor(private readonly root: string) {
    this.customDir = join(root, 'custom');
  }

  /** The file a model id names. Catalogue files sit at the top, where the first release put Whisper Small. */
  file(id: string): string {
    const entry = catalogueEntry(id);
    if (entry) return join(this.root, entry.file);
    if (!SPEECH_CUSTOM_ID.test(id)) throw invalidParams(`speech.model must be a catalogue id or custom-<12 hex>, not ${JSON.stringify(id)}`);
    return join(this.customDir, `${id}.bin`);
  }

  custom(id: string): CustomRecord | null {
    if (!SPEECH_CUSTOM_ID.test(id)) return null;
    try {
      const raw = JSON.parse(readFileSync(join(this.customDir, `${id}.json`), 'utf8')) as Partial<CustomRecord>;
      if (raw.id !== id || typeof raw.url !== 'string' || typeof raw.name !== 'string' || typeof raw.host !== 'string') return null;
      return { id, url: raw.url, name: raw.name, host: raw.host, bytes: typeof raw.bytes === 'number' ? raw.bytes : 0 };
    } catch {
      return null;
    }
  }

  saveCustom(record: CustomRecord): void {
    mkdirSync(this.customDir, { recursive: true });
    writeFileSync(join(this.customDir, `${record.id}.json`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  /** The file, its partial download and, for a custom model, its record. */
  remove(id: string): void {
    if (catalogueEntry(id)?.backend === 'nemotron') {
      rmSync(join(this.root, 'nemotron'), { recursive: true, force: true });
      return;
    }
    const file = this.file(id);
    rmSync(file, { force: true });
    rmSync(`${file}.part`, { force: true });
    rmSync(`${file}.part.json`, { force: true });
    if (!catalogueEntry(id)) rmSync(join(this.customDir, `${id}.json`), { force: true });
  }

  removeAll(): void {
    for (const model of SPEECH_CATALOGUE) this.remove(model.id);
    rmSync(this.customDir, { recursive: true, force: true });
  }

  installed(id: string): boolean {
    if (catalogueEntry(id)?.backend === 'nemotron') return NEMOTRON_FILES.every(file => {
      try { return statSync(join(this.root, 'nemotron', file.file)).isFile(); } catch { return false; }
    });
    try { return statSync(this.file(id)).isFile(); } catch { return false; }
  }

  list(): SpeechModel[] {
    const models: SpeechModel[] = SPEECH_CATALOGUE.map(entry => ({
      id: entry.id, kind: 'catalogue', name: entry.name, bytes: entry.bytes, tier: entry.tier, installed: this.installed(entry.id),
      ...(entry.backend ? { backend: entry.backend } : {}), ...(entry.streaming ? { streaming: true } : {}),
    }));
    if (!existsSync(this.customDir)) return models;
    const records = readdirSync(this.customDir)
      .filter(name => name.endsWith('.json'))
      .map(name => this.custom(name.slice(0, -5)))
      .filter((record): record is CustomRecord => record !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const record of records) {
      models.push({ id: record.id, kind: 'custom', name: record.name, bytes: record.bytes, host: record.host, installed: this.installed(record.id) });
    }
    return models;
  }
}
