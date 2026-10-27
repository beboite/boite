import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SharedProjectRef } from '../../../packages/contracts/src/index.ts';
import { startTestCore, waitFor, type TestCore } from '../../../packages/core/test/harness.ts';

/** Real journals, RPC sockets and signed/sealed peer requests; no FakeClient or provider login. */
export async function sharedCores() {
  const cores: TestCore[] = [], dirs: string[] = [];
  async function close() {
    for (const h of cores.splice(0).reverse()) await h.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
  }
  async function git(h: TestCore, cwd: string, ...args: string[]) {
    const proc = h.core.procs.spawn('thr_fixture', 'git', args, {cwd});
    const [out, err, code] = await Promise.all([new Response(proc.proc.stdout).text(), new Response(proc.proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`fixture git ${args[0]}: ${err}`);
    return out.trim();
  }
  async function side(name: string) {
    const dataDir = mkdtempSync(join(tmpdir(), 'boite-shared-e2e-')); dirs.push(dataDir);
    const h = await startTestCore({dataDir}); cores.push(h);
    const client = await h.connect();
    h.core.contacts.selfUrl = async () => h.url;
    h.core.contacts.setSettings({minTier: 2});
    const path = join(dataDir, 'project'); mkdirSync(path);
    await git(h, path, 'init', '-b', 'main');
    await git(h, path, 'config', 'core.autocrlf', 'false');
    await git(h, path, 'remote', 'add', 'origin', 'https://example.invalid/fixtures/shared.git');
    await git(h, path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'base');
    const project = await client.call('projects.add', {path, name});
    h.core.journal.db.run('UPDATE projects SET id=? WHERE id=?', ['prj_collision', project.id]);
    const account = h.core.accounts.list().find(a => a.providerId === 'echo')!;
    const thread = await client.call('threads.create', {projectId: 'prj_collision', providerId: 'echo', accountId: account.id, title: name});
    h.core.journal.db.run('UPDATE threads SET id=? WHERE id=?', ['thr_collision', thread.id]);
    const coreId = h.core.coordination.card().coreId;
    const ref: SharedProjectRef = {ownerCoreId: coreId, coreId, projectId: 'prj_collision'};
    return {h, client, path, ref, coreId, threadId: 'thr_collision', accountId: account.id};
  }
  async function restart(s: Awaited<ReturnType<typeof side>>) {
    const previous = s.h;
    await previous.stop();
    cores.splice(cores.indexOf(previous), 1);
    s.h = await startTestCore({dataDir: previous.dataDir, port: Number(new URL(previous.url).port)});
    cores.push(s.h);
    s.client = await s.h.connect();
    s.h.core.contacts.selfUrl = async () => s.h.url;
  }
  try {
    const a = await side('Owner A'), b = await side('Owner B'), member = await side('B member');
    await b.h.core.group.create('Fixture group');
    await member.h.core.group.join((await b.h.core.group.invite()).invite);
    member.ref.ownerCoreId = b.coreId;
    await a.client.call('contacts.join', {link: (await b.client.call('contacts.invite', {})).link});
    await waitFor(() => b.h.core.contacts.linked(a.coreId));
    await a.client.call('contacts.grant', {coreId: b.coreId, projectId: a.ref.projectId});
    await b.client.call('contacts.grant', {coreId: a.coreId, projectId: member.ref.projectId, machine: member.coreId});
    await waitFor(() => a.h.core.contacts.find(b.coreId)?.capabilities?.sharedProjects === 1 && member.h.core.contacts.members.relayedOf(a.coreId).length === 1);
    // Fixed base without wall-clock assumptions and without resetting either checkout.
    const baseCommit = await git(a.h, a.path, 'rev-parse', 'HEAD');
    await git(member.h, member.path, 'fetch', a.path, 'main');
    await git(member.h, member.path, 'checkout', '-B', 'main', baseCommit);
    return {a, b, member, git, baseCommit, restart, close};
  } catch (error) { await close(); throw error; }
}
