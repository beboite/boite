import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { connect, type CoreClient } from '../../packages/core/src/client.ts';
import { startCore, type RunningCore } from './lib/core.ts';

let core: RunningCore;
let owner: CoreClient;
let phone: CoreClient;
let threadId: string;
let cwd: string;

beforeAll(async () => {
  core = await startCore();
  owner = await connect(core.url, core.token);
  cwd = join(core.dataDir, 'project');
  mkdirSync(cwd);
  const project = await owner.call('projects.add', { path: cwd, name: 'Access boundaries' });
  const account = (await owner.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
  threadId = (await owner.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id })).id;
  const { grant } = await owner.call('pairing.grant', {});
  phone = await connect(core.url, '', { grant });
}, 30_000);

afterAll(async () => { phone?.close(); owner?.close(); await core?.stop(); }, 15_000);

test('a phone sees a completed turn but receives none of its process trace', async () => {
  const ownerTrace: number[] = [];
  const phoneTrace: number[] = [];
  const offOwner = owner.on('process.started', event => ownerTrace.push(event.pid));
  const offPhone = phone.on('process.started', event => phoneTrace.push(event.pid));
  try {
    await phone.call('threads.subscribe', { threadId });
    const finished = phone.next('turn.finished', turn => turn.threadId === threadId, 15_000);
    await phone.call('turns.start', { threadId, prompt: '[spawn:echo traced-child] trace boundary' });
    expect((await finished).status).toBe('done');
    await phone.call('threads.get', { threadId });
    await owner.call('threads.get', { threadId });
    expect(ownerTrace.length).toBeGreaterThan(0);
    expect(phoneTrace).toEqual([]);
    await expect(phone.call('trace.get', { threadId })).rejects.toThrow('owner only');
  } finally { offOwner(); offPhone(); }
}, 20_000);

test('a ticket cannot read a replacement directory outside its project', async () => {
  const folder = join(cwd, 'media');
  const outside = join(core.dataDir, 'outside');
  mkdirSync(folder);
  mkdirSync(outside);
  writeFileSync(join(folder, 'image.bin'), new Uint8Array([0, 1]));
  writeFileSync(join(outside, 'image.bin'), 'outside file');
  const content = await owner.call('files.read', { threadId, path: 'media/image.bin' });
  if (content.kind === 'text') throw new Error('expected a ticket');
  expect((await fetch(`${core.url}${content.url}`)).status).toBe(200);
  renameSync(folder, join(cwd, 'original-media'));
  symlinkSync(outside, folder, 'junction');
  expect((await fetch(`${core.url}${content.url}`)).status).toBe(404);
}, 10_000);
