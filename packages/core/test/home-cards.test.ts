import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { readHomeCard, readHomeCardRefresh } from '@boite/contracts';
import { startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';
import { thrown } from './settle.ts';

let harness: TestCore | null = null;

afterEach(async () => {
  await harness?.stop();
  harness = null;
});

const CARD = {
  schema: 1,
  title: { en: 'Nightly builds', fr: 'Builds de nuit' },
  status: { tone: 'ok', text: 'All green' },
  updatedAt: '2026-10-29T09:58:00Z',
  stats: [{ label: 'Passed', value: 12, tone: 'ok' }, { label: 'Queue', value: '3 jobs' }],
  lists: [{ title: 'Waiting', items: [{ label: 'windows-arm64', detail: 'Runner offline since 08:00', tone: 'warn' }] }],
  note: 'Line one\nLine two',
};

function cardDir(dataDir: string, id: string): string {
  const dir = join(dataDir, 'home-cards', id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A refresh script: counts its runs, then writes the card the env names, or exits with `code`. */
function script(dir: string, code = 0): string {
  const path = join(dir, 'refresh.js');
  writeFileSync(path, `
const fs = require('node:fs');
const path = require('node:path');
const runs = path.join(__dirname, 'runs');
fs.writeFileSync(runs, String(Number(fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8') : 0) + 1));
console.log('token=do-not-forward');
${code === 0
    ? `fs.writeFileSync(process.env.BOITE_HOME_CARD, JSON.stringify({ schema: 1, title: 'Fresh', stats: [{ label: 'Runs', value: Number(fs.readFileSync(runs, 'utf8')) }] }));`
    : `process.exit(${code});`}
`);
  writeFileSync(join(dir, 'refresh.json'), JSON.stringify({ schema: 1, command: [process.execPath, path], everyMinutes: 30 }));
  return path;
}

describe('the card files', () => {
  test('reads texts in several languages, tones, stats, lists and the note', () => {
    const read = readHomeCard(JSON.stringify(CARD));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.title).toEqual({ en: 'Nightly builds', fr: 'Builds de nuit' });
    expect(read.value.updatedAt).toBe(Date.parse('2026-10-29T09:58:00Z'));
    expect(read.value.stats[1]).toEqual({ label: 'Queue', value: '3 jobs', tone: null });
    expect(read.value.lists[0]!.items[0]).toEqual({ label: 'windows-arm64', detail: 'Runner offline since 08:00', tone: 'warn' });
  });

  test('refuses a typo, a wrong value and a text without English by file and field', () => {
    expect(readHomeCard(JSON.stringify({ ...CARD, stat: [] }))).toEqual({ ok: false, error: 'card.json: stat is not a field Boite reads (expected schema, title, status, updatedAt, stats, lists, note)' });
    expect(readHomeCard(JSON.stringify({ ...CARD, stats: [{ label: 'x', value: 1, tone: 'green' }] }))).toEqual({ ok: false, error: 'card.json: stats[0].tone must be one of ok, warn, bad, neutral, found "green"' });
    expect(readHomeCard(JSON.stringify({ ...CARD, title: { fr: 'Builds' } }))).toEqual({ ok: false, error: 'card.json: title.en must be the English text, required when a text has languages, found undefined' });
    expect(readHomeCardRefresh(JSON.stringify({ schema: 1, command: ['node', 'x.js'] }))).toEqual({ ok: false, error: 'refresh.json: command[0] must be an absolute path to the executable, found "node"' });
    expect(readHomeCardRefresh(JSON.stringify({ schema: 1, command: ['/usr/bin/node'], everyMinutes: 1 }))).toEqual({ ok: false, error: 'refresh.json: everyMinutes must be a whole number of minutes from 5 to 1440, or null for the button only, found 1' });
  });
});

describe('the home cards of a core', () => {
  test('lists every card directory with its content or the reason it was refused', async () => {
    harness = await startTestCore();
    writeFileSync(join(cardDir(harness.dataDir, 'builds'), 'card.json'), JSON.stringify(CARD));
    writeFileSync(join(cardDir(harness.dataDir, 'broken'), 'card.json'), '{"schema": 2}');
    mkdirSync(join(harness.dataDir, 'home-cards', 'Not An Id'));
    const client = await harness.connect();
    const cards = await client.call('homeCards.list', {});
    // The core read the directory at start, before these files existed; the button reads again.
    expect(cards.map(card => card.id)).toEqual([]);
    expect(await thrown(client.call('homeCards.refresh', { id: 'builds' }))).toThrow('builds has no usable refresh.json');
    const again = await client.call('homeCards.list', {});
    expect(again.map(card => [card.id, card.error])).toEqual([
      ['broken', 'card.json: schema must be 1, found 2'],
      ['builds', null],
    ]);
    expect(again[1]!.content?.stats).toHaveLength(2);
    expect(again[1]!.refresh).toBeNull();
  });

  test('a refresh runs the owner command once for two clicks, and its output never reaches the client', async () => {
    harness = await startTestCore();
    const dir = cardDir(harness.dataDir, 'fresh');
    script(dir);
    const client = await harness.connect();
    const updates: unknown[] = [];
    client.on('homeCards.updated', cards => updates.push(cards));
    const [first, second] = await Promise.all([
      client.call('homeCards.refresh', { id: 'fresh' }),
      client.call('homeCards.refresh', { id: 'fresh' }),
    ]);
    expect(readFileSync(join(dir, 'runs'), 'utf8')).toBe('1');
    expect(first).toEqual(second);
    expect(first.content?.title).toBe('Fresh');
    expect(first.content?.stats[0]!.value).toBe(1);
    expect(first.refresh).toMatchObject({ everyMinutes: 30, running: false, lastRun: { ok: true, message: null } });
    expect(JSON.stringify(updates)).toContain('"running":true');
    expect(JSON.stringify(updates)).not.toContain('do-not-forward');
  });

  test('a failing command keeps the last card and says how it ended', async () => {
    harness = await startTestCore();
    const dir = cardDir(harness.dataDir, 'down');
    writeFileSync(join(dir, 'card.json'), JSON.stringify(CARD));
    script(dir, 3);
    const client = await harness.connect();
    const card = await client.call('homeCards.refresh', { id: 'down' });
    expect(card.content?.title).toEqual(CARD.title);
    expect(card.refresh?.lastRun).toMatchObject({ ok: false, message: 'exited with code 3' });
    expect(JSON.stringify(card)).not.toContain('do-not-forward');
  });
});
