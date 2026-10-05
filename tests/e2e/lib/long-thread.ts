/**
 * A long conversation shaped like the ones people keep, written straight into
 * a stopped core's journal: 100 turns, each a prompt and an answer of 30 tool
 * calls, with a 1.5 MB file on every eighth prompt and a picture on every
 * 25th, about 48 MB of parts. Measured on 2026-10-05 on a working journal, the
 * text of a 97-message thread was 0.14 MB, its attached files 130 MB and its
 * tool outputs 25 MB; this is that shape, scaled down. Message ids start with
 * `msg_fixture`. A fixed seed gives the same bytes on every run.
 */
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { connect } from '../../../packages/core/src/client.ts';
import { startCore, type RunningCore, type StartCoreOptions } from './core.ts';

/** 100 turns: a user prompt and an assistant answer each. */
const TURNS = 100;
const TOOLS_PER_ANSWER = 30;

/** A fixed-seed generator, so two runs and two cores read the same bytes. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
const next = random(20261005);
const vocabulary = Array.from({ length: 1500 }, () => {
  const length = 2 + Math.floor(next() * next() * 12);
  return Array.from({ length }, () => 'etaoinshrdlcumwfgypbvkjxqz'[Math.floor(next() * next() * 26)]).join('');
});
function prose(chars: number): string {
  const out: string[] = [];
  let length = 0;
  while (length < chars) {
    const word = vocabulary[Math.floor(next() ** 2.2 * vocabulary.length)] as string;
    out.push(word);
    length += word.length + 1;
  }
  return out.join(' ');
}
/** Tool output reads like a listing: paths, line numbers, code. */
function listing(bytes: number): string {
  const lines: string[] = [];
  let length = 0;
  let line = 1;
  while (length < bytes) {
    const text = `packages/${vocabulary[line % 300]}/src/${vocabulary[(line * 7) % 900]}.ts:${line}: ${prose(60)}`;
    lines.push(text);
    length += text.length + 1;
    line += 1;
  }
  return lines.join('\n');
}
function base64Of(bytes: number): string {
  const buffer = Buffer.alloc(bytes);
  for (let index = 0; index < bytes; index += 1) buffer[index] = Math.floor(next() * 256);
  return buffer.toString('base64');
}
/** A real PNG of noise, so the browser decodes what it would decode for a screenshot. */
function png(width: number, height: number): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of data) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let index = 0; index < raw.length; index += 1) raw[index] = index % (width * 3 + 1) === 0 ? 0 : Math.floor(next() * 256);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

/** Writes the turns and messages of the fixture into the stopped core's journal. Returns the bytes of `parts` written. */
export function seedLongThread(dataDir: string, threadId: string): { messages: number; bytes: number } {
  const db = new Database(join(dataDir, 'journal.db'));
  let bytes = 0;
  let messages = 0;
  const start = Date.now() - TURNS * 60_000;
  const turn = db.prepare('INSERT INTO turns (id, thread_id, status, queued_at, started_at, finished_at, usage, error) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)');
  const message = db.prepare('INSERT INTO messages (id, thread_id, turn_id, role, parts, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (let index = 0; index < TURNS; index += 1) {
      const turnId = `turn_fixture${String(index).padStart(4, '0')}`;
      const at = start + index * 60_000;
      turn.run(turnId, threadId, 'done', at, at, at + 50_000);
      const userParts: unknown[] = [{ type: 'text', text: prose(300) }];
      if (index % 8 === 3) userParts.push({ type: 'file', mimeType: 'application/pdf', name: `report-${index}.pdf`, data: base64Of(1_500_000) });
      if (index % 25 === 7) userParts.push({ type: 'image', mimeType: 'image/png', alt: null, data: png(220, 220) });
      const answer: unknown[] = [{ type: 'text', text: prose(400) }];
      for (let tool = 0; tool < TOOLS_PER_ANSWER; tool += 1) {
        answer.push({
          type: 'tool',
          toolId: `tool_${index}_${tool}`,
          name: tool % 3 === 0 ? 'Read' : 'Bash',
          input: tool % 3 === 0 ? { file_path: `/src/${vocabulary[tool]}.ts` } : { command: `rg ${vocabulary[tool]} packages` },
          output: listing(tool % 10 === 9 ? 60_000 : 2_000),
          status: 'done',
          startedAt: at + tool * 1000,
          finishedAt: at + tool * 1000 + 400,
        });
      }
      answer.push({ type: 'text', text: prose(600) });
      for (const [role, parts, offset] of [['user', userParts, 0], ['assistant', answer, 1]] as const) {
        const json = JSON.stringify(parts);
        bytes += json.length;
        messages += 1;
        message.run(`msg_fixture${String(index).padStart(4, '0')}${role[0]}`, threadId, turnId, role, json, 'complete', at + offset);
      }
    }
  })();
  db.close();
  return { messages, bytes };
}


/**
 * A core whose journal holds the long thread and a short one beside it: the
 * core is started, the two threads made, the core stopped, the journal
 * seeded, and the core started again on the same data directory.
 */
export async function startCoreWithLongThread(options: StartCoreOptions = {}, projectPath?: string): Promise<{ core: RunningCore; long: string; short: string; messages: number; bytes: number }> {
  const first = await startCore(options);
  let long: string;
  let short: string;
  try {
    const client = await connect(first.url, first.token, { client: { name: 'fixture', version: '0' }, timeoutMs: 30_000 });
    try {
      const project = await client.call('projects.add', { path: projectPath ?? first.dataDir, name: 'bench' });
      const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'echo');
      if (account === undefined) throw new Error('the core has no echo account');
      long = (await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'A long conversation' })).id;
      // Opened before each measured open, so the click always switches threads.
      short = (await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'A short one' })).id;
    } finally {
      client.close();
    }
  } catch (error) {
    await first.stop();
    throw error;
  }
  await first.stop({ keepDataDir: true });
  // A failed start removes its data directory, fixture and all: give the stopped core's lock time to go first.
  await Bun.sleep(1_000);
  const seeded = seedLongThread(first.dataDir, long);
  await Bun.sleep(1_500);
  const core = await startCore({ ...options, dataDir: first.dataDir });
  return { core, long, short, ...seeded };
}
