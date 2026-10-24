import { afterEach, beforeEach, expect, test } from 'bun:test';
import { writeFileSync, rmSync, openSync, ftruncateSync, closeSync, readdirSync, utimesSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENV, ARTIFACT_MAX_BYTES, FILE_TICKET_TTL_MS } from '@boite/contracts';
import { Journal } from '../src/journal.ts';
import { FileTickets } from '../src/workdir.ts';
import { readArtifact } from '../src/artifacts.ts';
import { pruneArtifactSnapshots } from '../src/artifact-retention.ts';
import { connect, type CoreClient } from '../src/client.ts';
import { runCli } from '../src/cli.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

let harness: TestCore;
let client: CoreClient;
let agent: CoreClient;
let threadId: string;
beforeEach(async () => {
  harness = await startTestCore(); client = await harness.connect();
  ({ threadId } = await echoThread(harness, client));
  agent = await connect(harness.url, harness.core.agents.tokenFor(threadId));
  await client.call('turns.start', { threadId, prompt: 'Prepare a deliverable' });
  await waitFor(() => harness.core.threads.require(threadId).status === 'idle');
});
afterEach(async () => { agent?.close(); await harness?.stop(); });

test('agent CLI publishes immutable PDF bytes and subscribed clients receive the card', async () => {
  await client.call('threads.subscribe', { threadId });
  const path = join(harness.dataDir, 'report with spaces.pdf');
  const data = Buffer.from('%PDF-1.4\nreport\0bytes');
  writeFileSync(path, data);
  let output = '', error = '';
  const code = await runCli(['attach', path, '--json'], {
    cwd: harness.dataDir, env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) },
    out: text => output += text, err: text => error += text,
  });
  expect(error).toBe(''); expect(code).toBe(0);
  const sent = JSON.parse(output);
  expect(sent.role).toBe('assistant');
  expect(sent.parts[0]).toEqual({ type: 'file', name: 'report with spaces.pdf', mimeType: 'application/pdf', data: data.toString('base64') });
  rmSync(path);
  const history = await client.call('threads.get', { threadId });
  expect(history.messages.find(m => m.id === sent.id)?.parts).toEqual(sent.parts);
});

test('refuses unrelated threads, outside paths, missing files, directories and oversized data', async () => {
  const other = await echoThread(harness, client, 'another thread');
  expect(await thrown(agent.call('artifacts.publish', { threadId: other.threadId, path: 'report.pdf' }))).toThrow('is for thread');
  for (const [path, reason] of [['../outside.pdf', 'leaves'], ['missing.pdf', 'does not exist'], ['.', 'not a file']]) {
    expect(await thrown(agent.call('artifacts.publish', { threadId, path: path! }))).toThrow(reason!);
  }
  const fd = openSync(join(harness.dataDir, 'huge.bin'), 'w');
  try { ftruncateSync(fd, ARTIFACT_MAX_BYTES + 1); } finally { closeSync(fd); }
  expect(await thrown(agent.call('artifacts.publish', { threadId, path: 'huge.bin' }))).toThrow('512 MB');
});

test('publishes an empty file and refuses a thread without a turn or an archived thread', async () => {
  writeFileSync(join(harness.dataDir, 'empty.txt'), '');
  const sent = await agent.call('artifacts.publish', { threadId, path: 'empty.txt' });
  expect(sent.parts[0]).toMatchObject({ type: 'file', data: '' });
  const fresh = await echoThread(harness, client, 'fresh');
  expect(await thrown(client.call('artifacts.publish', { threadId: fresh.threadId, path: 'empty.txt' }))).toThrow('with a turn');
  await client.call('threads.archive', { threadId, archived: true });
  expect(await thrown(client.call('artifacts.publish', { threadId, path: 'empty.txt' }))).toThrow('active thread');
});

test('PDF links are binary tickets even when the document contains no NUL bytes', async () => {
  writeFileSync(join(harness.dataDir, 'ascii.pdf'), '%PDF-1.4\n%%EOF');
  const file = await client.call('files.read', { threadId, path: 'ascii.pdf' });
  expect(file).toMatchObject({ kind: 'binary', mime: 'application/pdf' });
});

test('large snapshots stay out of JSON, seek over HTTP, renew, survive restart and remain scoped', async () => {
  const original = join(harness.dataDir, 'long video.mp4');
  const bytes = Buffer.alloc(24 * 1024 * 1024, 73);
  bytes.write('beginning'); bytes.write('end', bytes.length - 3);
  writeFileSync(original, bytes);
  const sent = await agent.call('artifacts.publish', { threadId, path: original });
  expect(JSON.stringify(sent).length).toBeLessThan(1024);
  const part = sent.parts[0];
  expect(part).toMatchObject({ type: 'artifact', bytes: bytes.length, name: 'long video.mp4', mimeType: 'video/mp4' });
  if (part?.type !== 'artifact') throw new Error('missing snapshot');
  rmSync(original);
  const params = { threadId, messageId: sent.id, artifactId: part.id };
  const content = await client.call('artifacts.read', params);
  const url = new URL(content.url, harness.url.replace(/^ws/, 'http'));
  const response = await fetch(url, { headers: { range: 'bytes=0-8' } });
  expect(response.status).toBe(206);
  expect(response.headers.get('content-range')).toBe(`bytes 0-8/${bytes.length}`);
  expect(response.headers.get('content-disposition')).toContain('long%20video.mp4');
  expect(await response.text()).toBe('beginning');
  const tail = await fetch(url, { headers: { range: 'bytes=-3' } });
  expect(await tail.text()).toBe('end');
  expect((await fetch(url, { headers: { range: `bytes=${bytes.length}-` } })).status).toBe(416);
  const renewed = await client.call('artifacts.read', { ...params, renew: content.url.split('/').at(-1)! });
  expect(renewed.url).toBe(content.url);
  expect(harness.core.fileTickets.resolve(content.url.split('/').at(-1)!, Date.now() + FILE_TICKET_TTL_MS + 1)).toBeNull();
  expect((await fetch(url)).status).toBe(404);
  const other = await echoThread(harness, client, 'other');
  expect(await thrown(agent.call('artifacts.read', { ...params, threadId: other.threadId }))).toThrow('is for thread');
  expect(await thrown(client.call('artifacts.read', { ...params, threadId: other.threadId }))).toThrow('from this message and thread');
  expect(await thrown(client.call('artifacts.read', { ...params, artifactId: '../journal.db' }))).toThrow('from this message and thread');
  const { grant } = await client.call('pairing.grant', {});
  const phone = await connect(harness.url, '', { grant, client: { name: 'phone', version: 'test' } });
  try {
    const downloaded = await phone.call('artifacts.read', params);
    expect(Buffer.from(await (await fetch(new URL(downloaded.url, url))).arrayBuffer())).toEqual(bytes);
    expect(await thrown(phone.call('files.read', { threadId, path: 'journal.db' }))).toThrow('data folder');
  } finally { phone.close(); }
  // Reopen the persisted journal with a fresh ticket store, as a new core does.
  const reopened = new Journal(join(harness.dataDir, 'journal.db'));
  try {
    const tickets = new FileTickets();
    const restored = readArtifact({ threads: harness.core.threads, journal: reopened, dataDir: harness.dataDir, fileTickets: tickets, sharedAccess: harness.core.sharedAccess } as typeof harness.core, params);
    expect(restored.bytes).toBe(bytes.length);
    expect(tickets.resolve(restored.url.split('/').at(-1)!)).not.toBeNull();
    expect(reopened.getMessage(sent.id)?.parts).toEqual(sent.parts);
  } finally { reopened.close(); }
  expect(readdirSync(join(harness.dataDir, 'artifacts'))).toEqual([part.id]);
  const abandoned = join(harness.dataDir, 'artifacts', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.partial');
  writeFileSync(abandoned, 'incomplete');
  utimesSync(abandoned, 1, 1);
  // A view's gzipped copy goes with its snapshot; one whose snapshot nobody references goes too.
  writeFileSync(join(harness.dataDir, 'artifacts', `${part.id}.gz`), 'copy');
  writeFileSync(join(harness.dataDir, 'artifacts', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.gz'), 'orphan');
  // Retention keeps a snapshot still referenced by a fork, even after its original message is gone.
  const clone = { ...sent, id: 'msg_fork_fixture', threadId: other.threadId };
  harness.core.journal.putMessage(clone);
  harness.core.journal.db.query('DELETE FROM messages WHERE id = ?').run(sent.id);
  await pruneArtifactSnapshots(harness.core, Date.now() + 2 * 86_400_000);
  expect(readdirSync(join(harness.dataDir, 'artifacts')).sort()).toEqual([part.id, `${part.id}.gz`]);
  harness.core.journal.db.query('DELETE FROM messages WHERE id = ?').run(clone.id);
  await pruneArtifactSnapshots(harness.core, Date.now() + 2 * 86_400_000);
  expect(readdirSync(join(harness.dataDir, 'artifacts'))).toEqual([]);
});

test('a journal write during the reference scan leads to a rescan, not to a pass that deletes nothing', async () => {
  // A journal of its own: the test core's writes after its turn would interrupt the scans too.
  const dataDir = join(harness.dataDir, 'retention');
  const directory = join(dataDir, 'artifacts');
  mkdirSync(directory, { recursive: true });
  const journal = new Journal(join(dataDir, 'journal.db'));
  const core = { dataDir, journal } as unknown as typeof harness.core;
  const orphan = join(directory, 'cccccccc-cccc-cccc-cccc-cccccccccccc');
  writeFileSync(orphan, 'nobody references this');
  journal.db.run('CREATE TABLE scratch (n INTEGER)');
  const query = journal.db.query.bind(journal.db);
  // Every check of the write counter after a scan sees a turn persisting its stream first. Only the
  // retention pass's reads count: the WAL checkpointer reads the counter too, on its own timer.
  let busy = 0, checks = 0;
  journal.db.query = ((sql: string) => {
    if (sql === 'SELECT total_changes() AS count' && (checks += 1) % 2 === 0 && busy > 0) {
      busy -= 1;
      query('INSERT INTO scratch (n) VALUES (1)').run();
    }
    return query(sql);
  }) as typeof journal.db.query;
  const later = Date.now() + 2 * 86_400_000;
  try {
    // Written over during the first scan only: the rescan deletes it in the same pass.
    busy = 1;
    const done = await pruneArtifactSnapshots(core, later);
    expect(readdirSync(directory)).not.toContain('cccccccc-cccc-cccc-cccc-cccccccccccc');
    expect(done).toBe(true);
    // Written over during both scans: nothing goes, and the pass says it left work for a retry.
    writeFileSync(orphan, 'nobody references this');
    busy = 2; checks = 0;
    expect(await pruneArtifactSnapshots(core, later)).toBe(false);
    expect(readdirSync(directory)).toContain('cccccccc-cccc-cccc-cccc-cccccccccccc');
  } finally { journal.db.query = query; journal.close(); }
});
