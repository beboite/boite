import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ThreadSummary, Turn } from '../../../packages/contracts/src/index.ts';
import { connect } from '../../../packages/core/src/client.ts';
import { freshDataDir, startCore } from '../../e2e/lib/core.ts';
import { pidAlive, snapshot, tree } from '../../../bench/lib/proc.ts';

const providers = [
  { protocol: 'acp', fixture: 'acp-agent.ts' },
  { protocol: 'codex-appserver', fixture: 'codex-server.ts' },
  { protocol: 'pi', fixture: 'pi-agent.ts' },
] as const;

async function until(predicate: () => boolean, timeout = 30_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    assert(Date.now() < end, 'driver load did not settle');
    await Bun.sleep(20);
  }
}

export async function protocolLoad(perProvider: number): Promise<void> {
  const total = perProvider * providers.length;
  const dataDir = freshDataDir();
  mkdirSync(join(dataDir, 'providers'));
  for (const { protocol, fixture } of providers) {
    const profile = {
      detect: {}, executable: [{ kind: 'file', value: process.execPath }],
      launch: { args: [join(import.meta.dir, '..', '..', '..', 'packages', 'core', 'test', 'fixtures', fixture)] }, isolation: {},
    };
    writeFileSync(join(dataDir, 'providers', `${protocol}-stress.json`), JSON.stringify({
      id: `${protocol}-stress`, schemaVersion: 1, name: `${protocol} stress`, shortName: 'Stress', protocol,
      roots: ['{isolationDir}'], profiles: { windows: profile, linux: profile, macos: profile },
      auth: { kind: 'none' }, models: [{ id: 'default', name: 'Default', default: true }],
      capabilities: { approvals: true, hooks: false, checkpoint: false, images: true, planMode: false, resume: true },
    }));
  }
  const core = await startCore({ dataDir });
  const client = await connect(core.url, core.token).catch(async error => {
    await core.stop();
    throw error;
  });
  const pids = new Set<number>();
  try {
    await client.call('brain.configure', { path: null, enabled: false, boiteGuide: false });
    await client.call('settings.set', { maxConcurrentTurns: total, perAccountConcurrency: perProvider, warmProcessMinutes: 1, asyncQuestions: false });
    const project = await client.call('projects.add', { path: dataDir, name: 'Protocol stress' });
    const threads: ThreadSummary[] = [];
    for (const { protocol } of providers) {
      const account = await client.call('accounts.add', { providerId: `${protocol}-stress`, label: 'Stress', useDefaultLocation: true });
      for (let i = 0; i < perProvider; i++) {
        const thread = await client.call('threads.create', { projectId: project.id, providerId: `${protocol}-stress`, accountId: account.id });
        await client.call('threads.update', { threadId: thread.id, title: `Protocol ${protocol} ${i}` });
        await client.call('threads.subscribe', { threadId: thread.id });
        threads.push(thread);
      }
    }
    client.on('process.started', process => pids.add(process.pid));
    const finished = new Map<string, Turn>();
    client.on('turn.finished', turn => finished.set(turn.id, turn));
    let peakRunning = 0;
    client.on('scheduler.updated', state => { peakRunning = Math.max(peakRunning, state.running.length); });
    const run = async (selected: ThreadSummary[], prefix: string, directive = '', status = 'done') => {
      const turns = await Promise.all(selected.map(thread => client.call('turns.start', {
        threadId: thread.id, prompt: `${prefix}-${thread.id}${directive}`,
      })));
      await until(() => turns.every(turn => finished.has(turn.id)));
      for (const turn of turns) {
        assert.equal(finished.get(turn.id)?.status, status, `${turn.threadId}: ${finished.get(turn.id)?.error}`);
        if (status === 'done') {
          const thread = await client.call('threads.get', { threadId: turn.threadId });
          const answer = thread.messages.filter(m => m.turnId === turn.id && m.role === 'assistant')
            .flatMap(m => m.parts).filter(p => p.type === 'text').map(p => p.text).join('');
          assert.equal(answer, `${prefix}-${turn.threadId}`, 'cross-thread or duplicated stream');
        }
      }
    };
    await run(threads, 'cold');
    await until(() => pids.size === total);
    const warmPids = [...pids];
    const memory = process.platform === 'win32'
      ? tree(core.pid, snapshot()).reduce((bytes, process) => bytes + process.workingSetBytes, 0) : null;
    assert(warmPids.every(pidAlive), 'warm process ended early');
    await run(threads, 'warm');
    assert.equal(pids.size, total, 'warm turns spawned new agents');
    assert(warmPids.every(pidAlive), 'warm session replaced its agent');

    peakRunning = 0;
    const blocked = await Promise.all(threads.map(thread => client.call('turns.start', {
      threadId: thread.id, prompt: `blocked-${thread.id}[slow]`,
    })));
    await until(() => peakRunning === total);
    const stopped = await Promise.all(threads.map(thread => client.call('turns.stop', { threadId: thread.id })));
    assert(stopped.every(result => result.stopped));
    await until(() => blocked.every(turn => finished.get(turn.id)?.status === 'stopped'));
    await until(() => warmPids.every(pid => !pidAlive(pid)));
    const crash = [threads[0]!, threads[perProvider]!, threads[perProvider * 2]!];
    await run(crash, 'crash', '[crash]', 'error');
    await run(crash, 'recovered');
    const scheduler = await client.call('scheduler.get', {});
    assert.equal(scheduler.running.length + scheduler.queued.length, 0);
    console.log(JSON.stringify({ scenario: 'protocol process stress', processes: total, protocols: providers.map(p => p.protocol),
      coldAndWarmTurns: total * 2, stopped: total, crashedAndRecovered: 3, peakRunning, coreAndAgentBytes: memory }));
  } finally {
    client.close();
    await core.stop();
    await until(() => [...pids].every(pid => !pidAlive(pid)));
  }
}
