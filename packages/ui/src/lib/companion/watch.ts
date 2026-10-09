/*
 * What the companion knows of the user's other conversations in Boite: the
 * threads its agent is told about with each request (`threadsDigest`), the
 * ones that wait for the user (`waitingOnUser`, the radar) and the ones a
 * search finds (`rankThreads`). Pure, so it is tested without a core.
 */
import type { Message, PermissionRequest, QuestionRequest, ThreadProgress, ThreadSummary } from '@boite/contracts';
import { plain, replyText } from './brain';
import { describePermission } from './describe';

export interface WatchInput {
  threads: ThreadSummary[];
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  /** Project names by id. */
  projects: Map<string, string>;
  /** The companion's own conversations: never told, never waited for. */
  own: readonly string[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The threads the agent is told about with each request, at most. */
export const DIGEST_MAX = 12;
/** A thread idle for longer is left out of the digest. */
const DIGEST_SPAN = 3 * 24 * HOUR;
/** A finished thread left unread for longer no longer waits on the radar. */
const UNREAD_SPAN = 12 * HOUR;
/** What a thread's messages give to a search, at most. */
const TEXT_MAX = 40_000;

/** A length of time, for the agent: `under a minute`, `12 min`, `3 h 5 min`, `2 days`. */
export function span(ms: number): string {
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

/** On one line, cut past `max` characters, with no bracket that would close the context. */
function clip(text: string, max: number): string {
  const flat = plain(text).replace(/\s+/g, ' ');
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

const told = (thread: ThreadSummary, own: readonly string[]) => !own.includes(thread.id) && !thread.archived && !thread.incognito;

// ---------------------------------------------------------------------------
// The digest each request carries
// ---------------------------------------------------------------------------

/** Where a thread comes in the digest, the most pressing first; null leaves it out. */
function rankOf(thread: ThreadSummary, input: WatchInput, now: number): number | null {
  const asks = input.permissions.some((request) => request.threadId === thread.id) || input.questions.some((question) => question.threadId === thread.id);
  if (asks || thread.status === 'waiting') return 0;
  if (thread.status === 'running' || thread.status === 'queued') return 1;
  if (now - thread.updatedAt > DIGEST_SPAN) return null;
  if (thread.status === 'error') return 2;
  return thread.unread ? 3 : 4;
}

/** The threads the agent is told about: the ones that need the user, that run, that failed, finished unread, then the latest. */
export function digestThreads(input: WatchInput, now: number): ThreadSummary[] {
  return input.threads
    .flatMap((thread) => {
      const rank = told(thread, input.own) ? rankOf(thread, input, now) : null;
      return rank === null ? [] : [{ thread, rank }];
    })
    .sort((a, b) => a.rank - b.rank || b.thread.updatedAt - a.thread.updatedAt)
    .slice(0, DIGEST_MAX)
    .map(({ thread }) => thread);
}

const PHASES: Record<ThreadProgress['phase'], string> = {
  starting: 'starting',
  thinking: 'thinking',
  compacting: 'compacting its context',
  retrying: 'retrying',
  tool: 'using a tool',
  working: 'working',
  waiting: 'waiting'
};

/** What a thread is doing or waits for, in a few words. */
function stateOf(thread: ThreadSummary, input: WatchInput, now: number): string {
  const permission = input.permissions.find((request) => request.threadId === thread.id);
  if (permission) {
    const { target } = describePermission(permission);
    return `waits for the user's permission to use ${permission.toolName}${target ? `: ${clip(target, 100)}` : ''}, for ${span(now - permission.createdAt)}`;
  }
  const question = input.questions.find((entry) => entry.threadId === thread.id);
  if (question) {
    const options = question.options.map((option) => option.label).join(', ');
    return `asks the user: ${clip(question.text, 160)}${options ? ` (options: ${clip(options, 120)})` : ''}`;
  }
  if (thread.status === 'waiting') return 'waits for the user';
  if (thread.status === 'queued') return 'queued';
  if (thread.status === 'running') {
    const since = thread.requestSince ?? thread.runningSince;
    const progress = thread.progress ? `${PHASES[thread.progress.phase]}${thread.progress.detail ? ` (${clip(thread.progress.detail, 80)})` : ''}` : '';
    return ['running', since ? `for ${span(now - since)}` : '', progress].filter(Boolean).join(', ');
  }
  const ago = `${thread.status === 'error' ? 'failed' : 'finished'} ${span(now - thread.updatedAt)} ago`;
  return thread.unread ? `${ago}, not read yet` : ago;
}

/**
 * The user's threads as the agent is told about them with a request, one line
 * each: title, project, id, what it is doing or waits for, and the last
 * answer `answers` holds for it.
 */
export function threadsDigest(input: WatchInput, answers: Map<string, string>, now: number): string {
  const listed = digestThreads(input, now);
  if (listed.length === 0) return "The user's threads in Boite: none runs, waits or finished lately.";
  const lines = listed.map((thread) => {
    const project = thread.projectId ? input.projects.get(thread.projectId) : undefined;
    const answer = answers.get(thread.id);
    const where = project ? ` in ${clip(project, 40)}` : '';
    return `- "${clip(thread.title || 'untitled', 80)}"${where} (id ${thread.id}): ${stateOf(thread, input, now)}${answer ? `; its last answer: ${clip(answer, 160)}` : ''}`;
  });
  return `The user's threads in Boite, the ones that need them first:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// The radar: the threads that wait for the user
// ---------------------------------------------------------------------------

/** A permission or a question stops the thread; an answer or a failure waits to be read. */
export type RadarKind = 'permission' | 'question' | 'answer' | 'failed';

export interface RadarEntry {
  threadId: string;
  /** Empty for a thread no longer listed. */
  title: string;
  project: string;
  kind: RadarKind;
  /** Since when it waits, epoch milliseconds. */
  since: number;
}

/**
 * The threads that have waited for the user `minMs` or longer, the longest
 * first, one entry each: a permission, a question, or an answer left unread.
 * A delegated thread or an agent's session reports to whoever runs it, so only
 * what stops it counts. `askedAt` is when the companion first saw each
 * question, which carries no time of its own. `blockingOnly`, in focus: only
 * what stops an agent.
 */
export function waitingOnUser(input: WatchInput, askedAt: Map<string, number>, now: number, minMs: number, blockingOnly: boolean): RadarEntry[] {
  const byId = new Map(input.threads.map((thread) => [thread.id, thread]));
  const entries = new Map<string, RadarEntry>();
  const add = (threadId: string, kind: RadarKind, since: number) => {
    const thread = byId.get(threadId);
    if (entries.has(threadId) || input.own.includes(threadId) || thread?.archived || now - since < minMs) return;
    entries.set(threadId, { threadId, title: thread?.title ?? '', project: (thread?.projectId && input.projects.get(thread.projectId)) || '', kind, since });
  };
  for (const request of input.permissions) add(request.threadId, 'permission', request.createdAt);
  for (const question of input.questions) {
    if (blockingOnly && question.async) continue;
    const seen = askedAt.get(question.id) ?? now;
    // A blocking question stopped its thread: the thread changed then.
    add(question.threadId, 'question', question.async ? seen : Math.min(seen, byId.get(question.threadId)?.updatedAt ?? now));
  }
  if (!blockingOnly) {
    for (const thread of input.threads) {
      if ((thread.status !== 'idle' && thread.status !== 'error') || !thread.unread || thread.agentSessionId || thread.parentThreadId) continue;
      if (now - thread.updatedAt <= UNREAD_SPAN) add(thread.id, thread.status === 'error' ? 'failed' : 'answer', thread.updatedAt);
    }
  }
  return [...entries.values()].sort((a, b) => a.since - b.since);
}

// ---------------------------------------------------------------------------
// What a thread said, and the search
// ---------------------------------------------------------------------------

/** What a thread's last messages say: their text, for a search, and the agent's last answer. */
export interface ThreadText {
  text: string;
  /** The last words of the agent since the user's last message; empty when there are none. */
  answer: string;
}

export function threadText(messages: Pick<Message, 'role' | 'parts'>[]): ThreadText {
  let answer = '';
  for (const message of [...messages].reverse()) {
    if (message.role === 'user') break;
    if (message.role === 'assistant') answer = replyText(message);
    if (answer) break;
  }
  const said = messages.filter((message) => message.role === 'user' || message.role === 'assistant').map(replyText).filter(Boolean).join('\n\n');
  return { text: said.length > TEXT_MAX ? said.slice(-TEXT_MAX) : said, answer };
}

/** Lower case and no accents: `Été` finds `ete`. */
export const fold = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The words a search looks for, two characters or more, each once. */
export function queryWords(query: string): string[] {
  return [...new Set(fold(query).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2))];
}

function occurrences(text: string, word: string, max: number): number {
  let found = 0;
  for (let at = text.indexOf(word); at >= 0 && found < max; at = text.indexOf(word, at + word.length)) found++;
  return found;
}

/**
 * A few words of `text` around the first place a word appears, or empty when
 * none does. Folded character by character, so a place in the folded text is
 * a place in the text.
 */
export function excerptOf(text: string, words: string[], radius = 60): string {
  const starts: number[] = [];
  let folded = '';
  for (let index = 0; index < text.length; index++) {
    const piece = fold(text[index]!);
    for (let k = 0; k < piece.length; k++) starts.push(index);
    folded += piece;
  }
  let at = -1;
  let length = 0;
  for (const word of words) {
    const found = folded.indexOf(word);
    if (found >= 0 && (at < 0 || found < at)) [at, length] = [found, word.length];
  }
  if (at < 0) return '';
  const from = Math.max(0, starts[at]! - radius);
  const to = Math.min(text.length, starts[at + length - 1]! + 1 + radius);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`;
}

export interface Searchable {
  thread: ThreadSummary;
  project: string;
  /** What its messages say; empty for a thread the search did not read. */
  text: string;
}

export interface Match extends Searchable {
  excerpt: string;
}

/**
 * The threads that hold the most of `words`, in their title, project, branch
 * or messages, the best `max` of them: a word in the title weighs most, then
 * in the project, then each time the messages say it; the latest wins a tie.
 * `complete` when they hold every word.
 */
export function rankThreads(words: string[], items: Searchable[], max: number): { matches: Match[]; complete: boolean } {
  if (words.length === 0) return { matches: [], complete: false };
  const scored = items.map((item) => {
    const title = fold(item.thread.title ?? '');
    const place = fold(`${item.project} ${item.thread.branch ?? ''}`);
    const text = fold(item.text);
    let held = 0;
    let score = 0;
    for (const word of words) {
      const [inTitle, inPlace, times] = [title.includes(word), place.includes(word), occurrences(text, word, 20)];
      if (inTitle || inPlace || times > 0) held++;
      score += (inTitle ? 30 : 0) + (inPlace ? 10 : 0) + times;
    }
    return { item, held, score };
  });
  const best = Math.max(0, ...scored.map((entry) => entry.held));
  if (best === 0) return { matches: [], complete: false };
  const matches = scored
    .filter((entry) => entry.held === best)
    .sort((a, b) => b.score - a.score || b.item.thread.updatedAt - a.item.thread.updatedAt)
    .slice(0, max)
    .map(({ item }) => ({ ...item, excerpt: excerptOf(item.text, words) }));
  return { matches, complete: best === words.length };
}
