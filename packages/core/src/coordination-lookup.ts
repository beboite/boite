import type { AgentContact, AgentMatch, AgentTranscriptEntry, Message, MessagePart } from '@boite/contracts';
import type { Database } from 'bun:sqlite';
import { invalidParams } from './errors.ts';

/** At most this many words in a search; each costs one scan of the candidates' chat. */
export const SEARCH_WORDS = 8;
/** Matches returned by one core. */
export const SEARCH_RESULTS = 20;
const ENTRY_TEXT = 4000;
const EXCERPT_SIDE = 90;

/** Lower-cased words of at least two characters, deduplicated, or a refusal naming the field. */
export function searchWords(query: unknown): string[] {
  if (typeof query !== 'string' || query.trim().length === 0 || query.length > 500) throw invalidParams('query: expected 1 to 500 characters');
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter(word => word.length >= 2))];
  if (words.length === 0) throw invalidParams('query: expected at least one word of two characters or more');
  return words.slice(0, SEARCH_WORDS);
}

type Field = AgentMatch['matched'][number];

function fields(contact: AgentContact): [Field, string][] {
  return [
    ['title', contact.title],
    ['project', contact.project ?? ''],
    ['branch', contact.branch ?? ''],
    ['agent', contact.agent ?? ''],
    ['resources', contact.resources],
  ];
}

/** The text a user and an agent wrote in a message, without tool output or reasoning. */
function spoken(parts: MessagePart[]): string {
  return parts.flatMap(part => part.type === 'text' ? [part.text] : part.type === 'error' ? [`[error] ${part.message}`] : []).join('\n');
}

function excerpt(text: string, word: string): string {
  const at = text.toLowerCase().indexOf(word);
  const start = Math.max(0, at - EXCERPT_SIDE);
  const end = Math.min(text.length, at + word.length + EXCERPT_SIDE);
  return `${start > 0 ? '... ' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? ' ...' : ''}`;
}

const CHAT_TEXT = "j.value->>'type' = 'text' AND m.role IN ('user', 'assistant')";

/**
 * Contacts among `candidates` where every word appears in a field or in the
 * chat. Field matches rank first, then the most recently active.
 */
export function searchContacts(db: Database, candidates: AgentContact[], words: string[], readChat = true): AgentMatch[] {
  if (candidates.length === 0) return [];
  const ids = JSON.stringify(candidates.map(contact => contact.threadId));
  const inChat = new Map<string, Set<string>>();
  for (const word of readChat ? words : []) {
    const rows = db.query(`SELECT DISTINCT m.thread_id AS id FROM messages m, json_each(m.parts) j WHERE m.thread_id IN (SELECT value FROM json_each(?)) AND ${CHAT_TEXT} AND instr(lower(j.value->>'text'), ?) > 0`).all(ids, word) as { id: string }[];
    inChat.set(word, new Set(rows.map(row => row.id)));
  }
  const matches: AgentMatch[] = [];
  for (const contact of candidates) {
    const matched = new Set<Field>();
    const chatWords: string[] = [];
    let all = true;
    for (const word of words) {
      const hit = fields(contact).filter(([, value]) => value.toLowerCase().includes(word)).map(([field]) => field);
      for (const field of hit) matched.add(field);
      const chat = inChat.get(word)?.has(contact.threadId) === true;
      if (chat) chatWords.push(word);
      if (hit.length === 0 && !chat) { all = false; break; }
    }
    if (!all) continue;
    if (chatWords.length > 0) matched.add('chat');
    matches.push({ ...contact, matched: [...matched], excerpts: chatWords.length > 0 ? excerpts(db, contact.threadId, chatWords) : [] });
  }
  const fieldHits = (match: AgentMatch) => match.matched.filter(field => field !== 'chat').length;
  return matches.sort((a, b) => fieldHits(b) - fieldHits(a) || (b.activeAt ?? 0) - (a.activeAt ?? 0)).slice(0, SEARCH_RESULTS);
}

/** Up to three recent excerpts of one thread's chat, around the first word each message contains. */
function excerpts(db: Database, threadId: string, words: string[]): string[] {
  const rows = db.query(`SELECT j.value->>'text' AS text FROM messages m, json_each(m.parts) j WHERE m.thread_id = ? AND ${CHAT_TEXT} AND instr(lower(j.value->>'text'), ?) > 0 ORDER BY m.created_at DESC LIMIT 3`).all(threadId, words[0]!) as { text: string }[];
  return rows.map(row => excerpt(row.text, words.find(word => row.text.toLowerCase().includes(word)) ?? words[0]!));
}

/**
 * The newest `limit` entries before `before`, oldest first, and whether older
 * ones remain. Only those rows are read: a long thread's tool output is never
 * loaded whole.
 */
export function transcript(db: Database, threadId: string, limit: number, before: number | undefined): { entries: AgentTranscriptEntry[]; more: boolean } {
  const entries: AgentTranscriptEntry[] = [];
  const cursor = before ?? Number.MAX_SAFE_INTEGER;
  let skip = 0;
  // A message with neither text nor a tool (reasoning alone) is skipped, so a page may take another read.
  for (;;) {
    const rows = db.query('SELECT id, role, parts, created_at FROM messages WHERE thread_id = ? AND created_at <= ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?').all(threadId, cursor, limit, skip) as { id: string; role: Message['role']; parts: string; created_at: number }[];
    for (const row of rows) {
      if (entries.length === limit) break;
      skip += 1;
      if (row.created_at >= (before ?? Number.MAX_SAFE_INTEGER)) continue;
      const parts = JSON.parse(row.parts) as MessagePart[];
      const text = spoken(parts);
      const tools = parts.flatMap(part => part.type === 'tool' ? [part.name] : []);
      if (text.length === 0 && tools.length === 0) continue;
      entries.push({ id: row.id, role: row.role, at: row.created_at, text: text.length > ENTRY_TEXT ? `${text.slice(0, ENTRY_TEXT)} ...` : text, tools });
    }
    if (entries.length === limit || rows.length < limit) break;
  }
  const more = entries.length === limit && db.query('SELECT 1 FROM messages WHERE thread_id = ? AND created_at <= ? LIMIT 1 OFFSET ?').get(threadId, cursor, skip) !== null;
  return { entries: entries.reverse(), more };
}

/** A transcript from another core, checked field by field before it reaches an agent. */
export function checkTranscript(value: unknown): { entries: AgentTranscriptEntry[]; more: boolean } {
  const raw = value as { entries?: unknown; more?: unknown } | null;
  if (!raw || !Array.isArray(raw.entries) || raw.entries.length > 100 || typeof raw.more !== 'boolean') throw invalidParams('transcript: expected at most 100 entries and a more flag');
  const entries = raw.entries.map((entry: Partial<AgentTranscriptEntry>, index) => {
    if (!entry || typeof entry.id !== 'string' || !['user', 'assistant', 'system'].includes(entry.role as string) || !Number.isSafeInteger(entry.at)
      || typeof entry.text !== 'string' || entry.text.length > ENTRY_TEXT + 4 || !Array.isArray(entry.tools) || entry.tools.some(tool => typeof tool !== 'string' || tool.length > 200)) {
      throw invalidParams(`transcript.entries[${index}]: expected id, role, at, text up to ${ENTRY_TEXT} characters and tool names`);
    }
    return { id: entry.id.slice(0, 100), role: entry.role!, at: entry.at!, text: entry.text, tools: entry.tools.slice(0, 50) };
  });
  return { entries, more: raw.more };
}

/** A search result from another core, checked before it reaches an agent. */
export function checkMatchExtras(value: { matched?: unknown; excerpts?: unknown }): Pick<AgentMatch, 'matched' | 'excerpts'> {
  const allowed: Field[] = ['title', 'project', 'branch', 'agent', 'resources', 'chat'];
  if (!Array.isArray(value.matched) || value.matched.some(field => !allowed.includes(field as Field))) throw invalidParams('match.matched: expected field names');
  if (!Array.isArray(value.excerpts) || value.excerpts.length > 3 || value.excerpts.some(text => typeof text !== 'string' || text.length > 400)) throw invalidParams('match.excerpts: expected up to three short excerpts');
  return { matched: [...new Set(value.matched as Field[])], excerpts: value.excerpts as string[] };
}
