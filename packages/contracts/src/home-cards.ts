import type { Timestamp } from './ids';

/*
 * Home cards: read-only status cards under the composer of the new-thread
 * screen. Each one is a directory `<dataDir>/home-cards/<id>/` the owner
 * creates. A script of theirs writes `card.json`, what the card shows; an
 * optional `refresh.json` names that script, so Boite can run it on a button
 * and on a schedule. Boite never reaches the data a card describes: it reads
 * the file and runs the one command the owner wrote down.
 *
 * The readers below are pure and shared, so the core and the in-memory client
 * refuse the same file with the same words.
 */

export const HOME_CARDS_DIR = 'home-cards';
export const HOME_CARD_FILE = 'card.json';
export const HOME_CARD_REFRESH_FILE = 'refresh.json';
/** Either file, read whole. A status card has no business being larger. */
export const HOME_CARD_MAX_BYTES = 64 * 1024;
export const HOME_CARD_REFRESH_MIN_MINUTES = 5;
export const HOME_CARD_REFRESH_MAX_MINUTES = 1440;

/** The colour of a status, a figure or a row: green, amber, red, or muted. Without one, the accent. */
export type HomeCardTone = 'ok' | 'warn' | 'bad' | 'neutral';
export const HOME_CARD_TONES: readonly HomeCardTone[] = ['ok', 'warn', 'bad', 'neutral'];

/**
 * A text in one language, or in several keyed by language with `en` required:
 * `{ "en": "Ready", "fr": "Prêts" }`. The app shows its own language and falls
 * back to English.
 */
export type HomeCardText = string | ({ en: string } & Record<string, string>);

export interface HomeCardStat {
  label: HomeCardText;
  value: number | string;
  tone: HomeCardTone | null;
}

export interface HomeCardItem {
  label: HomeCardText;
  /** Shown behind the row's "i", never inline. */
  detail: HomeCardText | null;
  tone: HomeCardTone | null;
}

export interface HomeCardList {
  title: HomeCardText;
  items: HomeCardItem[];
}

/** What `card.json` says, once read. */
export interface HomeCardContent {
  title: HomeCardText;
  status: { tone: HomeCardTone; text: HomeCardText } | null;
  /** When the data itself was taken, which can be older than the file. */
  updatedAt: Timestamp | null;
  stats: HomeCardStat[];
  lists: HomeCardList[];
  /** Longer prose behind the title's "i". */
  note: HomeCardText | null;
}

/** What `refresh.json` says, once read. */
export interface HomeCardCommand {
  /** An absolute executable path, then its arguments. No shell runs it. */
  command: string[];
  /** Null runs it only from the card's button. */
  everyMinutes: number | null;
}

export interface HomeCardRun {
  at: Timestamp;
  ok: boolean;
  /** Why it failed: an exit code or a timeout. The script's own output never leaves the core. */
  message: string | null;
}

export interface HomeCard {
  /** The directory's name. */
  id: string;
  /** Null when `card.json` is missing or refused. */
  content: HomeCardContent | null;
  /** When `card.json` last changed on disk. */
  changedAt: Timestamp | null;
  /** Why a file was refused: the file, the field and what was expected. */
  error: string | null;
  /** Null without a usable `refresh.json`. */
  refresh: { everyMinutes: number | null; running: boolean; lastRun: HomeCardRun | null } | null;
}

export interface HomeCardsRpcMethods {
  /** Every card directory, sorted by id, refused ones included with their reason. */
  'homeCards.list': { params: Record<string, never>; result: HomeCard[] };
  /**
   * Runs the card's `refresh.json` command now and answers once it ended and
   * `card.json` was read again. A run already going is joined, not doubled.
   */
  'homeCards.refresh': { params: { id: string }; result: HomeCard };
}

export interface HomeCardsRpcEvents {
  /** The whole list, whenever a card's files change or a refresh starts or ends. */
  'homeCards.updated': HomeCard[];
}

const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** A card directory name Boite reads: lowercase letters, digits and inner hyphens, 1 to 64 characters. */
export function isHomeCardId(value: string): boolean {
  return ID.test(value);
}

type Read<T> = { ok: true; value: T } | { ok: false; error: string };

class Refusal extends Error {}

function shown(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function refuse(file: string, field: string, expected: string, value: unknown): never {
  throw new Refusal(`${file}: ${field} must be ${expected}, found ${shown(value)}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Control characters other than the newline a note may hold.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;

function object(file: string, field: string, value: unknown, known: readonly string[]): Record<string, unknown> {
  if (!isObject(value)) refuse(file, field, 'an object', value);
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      throw new Refusal(`${file}: ${field === '' ? '' : `${field}.`}${key} is not a field Boite reads (expected ${known.join(', ')})`);
    }
  }
  return value;
}

function plain(file: string, field: string, value: unknown, max: number, lines = false): string {
  const expected = `a string of 1 to ${max} characters${lines ? '' : ' on one line'}`;
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) refuse(file, field, expected, value);
  if (CONTROL.test(value) || (!lines && value.includes('\n'))) refuse(file, field, expected, value);
  return value;
}

function text(file: string, field: string, value: unknown, max: number, lines = false): HomeCardText {
  if (!isObject(value)) return plain(file, field, value, max, lines);
  if (!('en' in value)) refuse(file, `${field}.en`, 'the English text, required when a text has languages', undefined);
  const out: Record<string, string> = {};
  for (const [language, entry] of Object.entries(value)) {
    if (!/^[a-z]{2,3}$/.test(language)) {
      throw new Refusal(`${file}: ${field}.${language} is not a language code (expected two or three lowercase letters, like en or fr)`);
    }
    out[language] = plain(file, `${field}.${language}`, entry, max, lines);
  }
  return out as HomeCardText;
}

function tone(file: string, field: string, value: unknown): HomeCardTone {
  if (typeof value !== 'string' || !(HOME_CARD_TONES as readonly string[]).includes(value)) refuse(file, field, `one of ${HOME_CARD_TONES.join(', ')}`, value);
  return value as HomeCardTone;
}

function list<T>(file: string, field: string, value: unknown, max: number, each: (entry: unknown, at: string) => T): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) refuse(file, field, `an array of at most ${max} entries`, value);
  return value.map((entry, index) => each(entry, `${field}[${index}]`));
}

function parse(file: string, raw: string): unknown {
  if (raw.length > HOME_CARD_MAX_BYTES) throw new Refusal(`${file}: larger than ${HOME_CARD_MAX_BYTES / 1024} KB`);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Refusal(`${file}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

function attempt<T>(read: () => T): Read<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.message };
    throw error;
  }
}

/** Reads `card.json`. Nothing optional is guessed and nothing unknown is ignored: a typo is named. */
export function readHomeCard(raw: string): Read<HomeCardContent> {
  const file = HOME_CARD_FILE;
  return attempt(() => {
    const root = object(file, '', parse(file, raw), ['schema', 'title', 'status', 'updatedAt', 'stats', 'lists', 'note']);
    if (root.schema !== 1) refuse(file, 'schema', '1', root.schema);
    let status: HomeCardContent['status'] = null;
    if (root.status !== undefined && root.status !== null) {
      const entry = object(file, 'status', root.status, ['tone', 'text']);
      status = { tone: tone(file, 'status.tone', entry.tone), text: text(file, 'status.text', entry.text, 80) };
    }
    let updatedAt: Timestamp | null = null;
    if (root.updatedAt !== undefined && root.updatedAt !== null) {
      const at = typeof root.updatedAt === 'string' ? Date.parse(root.updatedAt) : Number.NaN;
      if (!Number.isFinite(at)) refuse(file, 'updatedAt', 'an ISO 8601 date like 2026-10-29T09:58:00Z', root.updatedAt);
      updatedAt = at;
    }
    const stats = list(file, 'stats', root.stats, 6, (entry, at) => {
      const stat = object(file, at, entry, ['label', 'value', 'tone']);
      const value = stat.value;
      const number = typeof value === 'number' && Number.isFinite(value);
      if (!number) plain(file, `${at}.value`, value, 24);
      return {
        label: text(file, `${at}.label`, stat.label, 40),
        value: value as number | string,
        tone: stat.tone === undefined || stat.tone === null ? null : tone(file, `${at}.tone`, stat.tone),
      };
    });
    const lists = list(file, 'lists', root.lists, 4, (entry, at) => {
      const group = object(file, at, entry, ['title', 'items']);
      return {
        title: text(file, `${at}.title`, group.title, 40),
        items: list(file, `${at}.items`, group.items, 20, (row, where) => {
          const item = object(file, where, row, ['label', 'detail', 'tone']);
          return {
            label: text(file, `${where}.label`, item.label, 60),
            detail: item.detail === undefined || item.detail === null ? null : text(file, `${where}.detail`, item.detail, 400, true),
            tone: item.tone === undefined || item.tone === null ? null : tone(file, `${where}.tone`, item.tone),
          };
        }),
      };
    });
    return {
      title: text(file, 'title', root.title, 60),
      status,
      updatedAt,
      stats,
      lists,
      note: root.note === undefined || root.note === null ? null : text(file, 'note', root.note, 4000, true),
    };
  });
}

/** Reads `refresh.json`. The executable must be absolute: the core's PATH is not the owner's shell. */
export function readHomeCardRefresh(raw: string): Read<HomeCardCommand> {
  const file = HOME_CARD_REFRESH_FILE;
  return attempt(() => {
    const root = object(file, '', parse(file, raw), ['schema', 'command', 'everyMinutes']);
    if (root.schema !== 1) refuse(file, 'schema', '1', root.schema);
    const command = root.command;
    if (!Array.isArray(command) || command.length === 0 || command.length > 32) refuse(file, 'command', 'an array of 1 to 32 strings: an absolute executable path, then its arguments', command);
    command.forEach((part, index) => plain(file, `command[${index}]`, part, 1024));
    const executable = command[0] as string;
    if (!(executable.startsWith('/') || /^[A-Za-z]:[\\/]/.test(executable))) refuse(file, 'command[0]', 'an absolute path to the executable', executable);
    let everyMinutes: number | null = null;
    if (root.everyMinutes !== undefined && root.everyMinutes !== null) {
      const value = root.everyMinutes;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < HOME_CARD_REFRESH_MIN_MINUTES || value > HOME_CARD_REFRESH_MAX_MINUTES) {
        refuse(file, 'everyMinutes', `a whole number of minutes from ${HOME_CARD_REFRESH_MIN_MINUTES} to ${HOME_CARD_REFRESH_MAX_MINUTES}, or null for the button only`, value);
      }
      everyMinutes = value;
    }
    return { command: command as string[], everyMinutes };
  });
}
