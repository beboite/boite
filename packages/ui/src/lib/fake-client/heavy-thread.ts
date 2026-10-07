import type { Message, MessagePart, Thread, Turn } from '@boite/contracts';
import { T0 } from './shared.ts';

/**
 * A thread shaped like the heavy ones a long agent session leaves, what
 * `?fake=1&heavy=1` opens the list on: forty messages weighing about 11.5 MiB,
 * almost all of it in tool calls. The shape is the one four real threads of 15
 * to 23 MB showed on 2026-10-07: an assistant message carries a whole turn of
 * work, up to a thousand calls and more, in runs of about ten between two
 * short paragraphs; a call's output is 365 characters at the median and 8 KB
 * at the 90th percentile; almost no diff, almost no fenced code.
 *
 * Everything is drawn from one seeded generator, so two builds scroll the same
 * conversation and a bench compares like with like.
 */

/**
 * Tool calls per turn. The last turn is the one a window per message cannot
 * split, and where the thread opens: a scroll up from the bottom crosses it.
 */
const TURN_CALLS = [96, 355, 49, 780, 240, 33, 596, 177, 476, 1307];

/** Deterministic: mulberry32, the same sequence in every browser. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** A value read off a measured distribution: `points` are (share, value) pairs, in order. */
function quantile(points: readonly (readonly [number, number])[], share: number): number {
  for (let index = 1; index < points.length; index += 1) {
    const [toShare, toValue] = points[index]!;
    const [fromShare, fromValue] = points[index - 1]!;
    if (share <= toShare) return Math.round(fromValue + ((share - fromShare) / (toShare - fromShare)) * (toValue - fromValue));
  }
  return points.at(-1)![1];
}

/** Calls and reasoning between two paragraphs: 10 at the median, 98 at most. */
const RUN_LENGTH = [[0, 1], [0.5, 10], [0.75, 17], [0.9, 25], [0.99, 44], [1, 98]] as const;
/** Characters of one call's output. Past 16 KB the core would send a preview. */
const OUTPUT_CHARS = [[0, 0], [0.5, 365], [0.75, 2729], [0.9, 8416], [0.99, 15800], [1, 16000]] as const;
/** Characters of the paragraph between two runs. */
const TEXT_CHARS = [[0, 60], [0.5, 277], [0.75, 325], [0.9, 375], [0.99, 860], [1, 2400]] as const;

const FILES = ['packages/core/src/journal.ts', 'packages/core/src/threads/snapshot.ts', 'packages/ui/src/components/MessageList.svelte', 'packages/ui/src/lib/message-window.ts', 'packages/contracts/src/index.ts', 'apps/shell/src-tauri/src/platform/windows.rs', 'bench/ui-frames.ts', 'docs/performance.md', 'packages/ui/src/lib/store/threads.svelte.ts', 'packages/core/test/journal-pages.test.ts', 'packages/ui/src/app.css', 'tests/e2e/mobile.test.ts'];
const COMMANDS = ['git status --short', 'bun run check', 'bun test packages/ui/src/components/MessageList.test.ts', 'rg -n "listMessagePage" packages/core/src', 'git diff --stat origin/main', 'bun run --cwd packages/ui test -- message-window', 'cargo check --manifest-path apps/shell/src-tauri/Cargo.toml', 'ls -la packages/ui/dist/assets', 'gh pr checks 364 --watch', 'bun bench/ui-frames.ts --runs 3 --only "long thread scroll"', 'sed -n 320,410p packages/ui/src/components/MessageList.svelte', 'cd packages/core && bun test test/journal.test.ts --timeout 20000'];
const WORDS = ['window', 'measures', 'the', 'slot', 'before', 'page', 'returns', 'a', 'cursor', 'for', 'older', 'rows', 'and', 'journal', 'keeps', 'each', 'message', 'whole', 'while', 'scroll', 'anchors', 'on', 'visible', 'row', 'then', 'restores', 'its', 'offset', 'after', 'layout', 'so', 'reader', 'stays', 'where', 'they', 'were', 'test', 'covers', 'both', 'transports', 'fake', 'client', 'mirrors', 'core'];

/** A hundred output lines the calls draw from: paths, test lines, counters. */
function outputLines(random: () => number): string[] {
  const lines: string[] = [];
  for (let index = 0; index < 160; index += 1) {
    const file = FILES[Math.floor(random() * FILES.length)]!;
    const kind = index % 5;
    if (kind === 0) lines.push(`${file}:${1 + Math.floor(random() * 900)}:${1 + Math.floor(random() * 80)}  ${sentence(random, 6 + Math.floor(random() * 8))}`);
    else if (kind === 1) lines.push(`(pass) ${sentence(random, 4 + Math.floor(random() * 6))} [${(random() * 40).toFixed(2)}ms]`);
    else if (kind === 2) lines.push(` M ${file}`);
    else if (kind === 3) lines.push(`    at ${WORDS[Math.floor(random() * WORDS.length)]} (${file}:${1 + Math.floor(random() * 900)})`);
    else lines.push(sentence(random, 8 + Math.floor(random() * 10)));
  }
  return lines;
}

function sentence(random: () => number, words: number): string {
  let out = '';
  for (let index = 0; index < words; index += 1) out += (index ? ' ' : '') + WORDS[Math.floor(random() * WORDS.length)]!;
  return out;
}

function textOf(lines: string[], random: () => number, chars: number): string {
  let out = '';
  while (out.length < chars) out += (out ? '\n' : '') + lines[Math.floor(random() * lines.length)]!;
  return out.slice(0, chars);
}

/** The paragraph an agent writes between two runs: a sentence or two, a path in code, sometimes a word in bold. */
function paragraph(random: () => number, chars: number): string {
  let out = '';
  while (out.length < chars) {
    const file = FILES[Math.floor(random() * FILES.length)]!;
    const piece = random() < 0.35 ? `\`${file}\` ` : random() < 0.12 ? `**${sentence(random, 2)}** ` : `${sentence(random, 5 + Math.floor(random() * 9))}. `;
    out += out.length > 0 && random() < 0.06 ? `\n\n${piece}` : piece;
  }
  return out.slice(0, chars).trim();
}

/** A turn's closing answer: headings, a list, a table and one fenced block, the heaviest text a thread holds. */
function answer(random: () => number, turn: number): string {
  const rows = Array.from({ length: 5 }, (_, index) => `| ${FILES[(turn + index) % FILES.length]} | ${Math.floor(random() * 400)} | ${sentence(random, 4)} |`).join('\n');
  const items = Array.from({ length: 6 }, () => `- ${sentence(random, 9 + Math.floor(random() * 8))}`).join('\n');
  const code = Array.from({ length: 12 }, (_, index) => `  ${index % 3 === 0 ? 'const' : 'return'} ${WORDS[Math.floor(random() * WORDS.length)]}${index} = ${sentence(random, 3).replaceAll(' ', '.')}();`).join('\n');
  return `## What changed in turn ${turn + 1}\n\n${paragraph(random, 420)}\n\n${items}\n\n### Numbers\n\n| File | Lines | Note |\n|---|---|---|\n${rows}\n\n\`\`\`ts\nfunction turn${turn}() {\n${code}\n}\n\`\`\`\n\n${paragraph(random, 380)}`;
}

function call(random: () => number, lines: string[], id: string, at: number): Extract<MessagePart, { type: 'tool' }> {
  const pick = random();
  const file = FILES[Math.floor(random() * FILES.length)]!;
  const failed = random() < 0.055;
  let name: string;
  let input: unknown;
  if (pick < 0.79) {
    name = pick < 0.66 ? 'Bash' : 'exec';
    input = { command: `${COMMANDS[Math.floor(random() * COMMANDS.length)]}${random() < 0.3 ? ` | head -${20 + Math.floor(random() * 80)}` : ''}`, description: sentence(random, 5 + Math.floor(random() * 5)) };
  } else if (pick < 0.87) {
    name = 'Read';
    input = { file_path: file, offset: Math.floor(random() * 600), limit: 120 };
  } else if (pick < 0.92) {
    name = 'Grep';
    input = { pattern: WORDS[Math.floor(random() * WORDS.length)], path: file.split('/').slice(0, 2).join('/') };
  } else if (pick < 0.98) {
    // Codex's patch: an edit by its name, with no before and after to draw a diff from.
    name = 'ApplyPatch';
    input = { path: file, patch: textOf(lines, random, 300 + Math.floor(random() * 900)) };
  } else if (pick < 0.997) {
    name = 'Agent';
    input = { description: sentence(random, 4), prompt: paragraph(random, 500) };
  } else {
    name = 'Edit';
    input = { file_path: file, old_string: textOf(lines, random, 240), new_string: textOf(lines, random, 300) };
  }
  const output = textOf(lines, random, quantile(OUTPUT_CHARS, random()));
  const took = 40 + Math.floor(random() * 4000);
  return { type: 'tool', toolId: id, name, input, output, status: failed ? 'error' : 'done', ...(name === 'Bash' ? { exitCode: failed ? 1 : 0 } : {}), startedAt: at, finishedAt: at + took };
}

/** The work of one turn: runs of calls, a paragraph between two of them. */
function work(random: () => number, lines: string[], turn: number, calls: number, from: number): MessagePart[] {
  const parts: MessagePart[] = [{ type: 'text', text: paragraph(random, quantile(TEXT_CHARS, random())), complete: true }];
  let at = from;
  let left = calls;
  let made = 0;
  while (left > 0) {
    const run = Math.min(left, quantile(RUN_LENGTH, random()));
    for (let step = 0; step < run; step += 1) {
      // One step in ten is reasoning; most of it left no words and took no time, and is not drawn.
      if (random() < 0.1) parts.push({ type: 'thinking', text: random() < 0.2 ? paragraph(random, 160) : '', startedAt: at, finishedAt: at + 300 });
      const part = call(random, lines, `heavy-${turn}-${made}`, at);
      made += 1;
      at = (part.finishedAt ?? at) + 200;
      parts.push(part);
    }
    left -= run;
    parts.push({ type: 'text', text: paragraph(random, quantile(TEXT_CHARS, random())), complete: true });
  }
  return parts;
}

export function heavyThread(): Thread {
  const random = generator(0x11_05_2026);
  const lines = outputLines(random);
  const messages: Message[] = [];
  const turns: Turn[] = [];
  let at = T0 + 900_000;
  const add = (turnId: string, role: Message['role'], parts: MessagePart[]): void => {
    messages.push({ id: `m-heavy-${messages.length}`, threadId: 't-heavy', turnId, role, parts, state: 'complete', createdAt: at });
    at += 1000;
  };
  TURN_CALLS.forEach((calls, turn) => {
    const turnId = `turn-heavy-${turn}`;
    const startedAt = at;
    add(turnId, 'user', [{ type: 'text', text: paragraph(random, 180 + Math.floor(random() * 500)) }]);
    // A notice between a prompt and its work, as agent mail and hooks leave them.
    if (turn % 2 === 1) add(turnId, 'system', [{ type: 'text', text: paragraph(random, 220) }]);
    add(turnId, 'assistant', work(random, lines, turn, calls, at));
    at += calls * 2500;
    if (turn % 2 === 0) add(turnId, 'assistant', [{ type: 'text', text: paragraph(random, 300), complete: true }]);
    add(turnId, 'assistant', [{ type: 'text', text: answer(random, turn), complete: true }]);
    turns.push({
      id: turnId, threadId: 't-heavy', status: 'done', queuedAt: startedAt, startedAt, finishedAt: at,
      usage: { inputTokens: 41_200 + calls * 90, outputTokens: 18_400 + calls * 40, cacheReadTokens: 210_000, cacheWriteTokens: 12_000, costUsdEquivalent: 1.24 },
      error: null
    });
  });
  return {
    id: 't-heavy', projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null, permissionMode: 'default',
    archived: false, pinned: false, title: 'Eleven megabytes of tool calls', titleSource: 'prompt', cwd: 'C:\\src\\boite', branch: null,
    status: 'idle', unread: false, sessionId: 'sess-heavy', load: null, context: null,
    createdAt: T0 + 900_000, updatedAt: at, messagesBefore: null, commands: [], turns, messages
  };
}
