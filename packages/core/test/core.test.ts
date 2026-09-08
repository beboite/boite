import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { echoThread, startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';
import { newId } from '../src/ids.ts';
import { parseFlags, resolveHost } from '../src/main.ts';
import { dataDirName, defaultDataDir, resolveDataDir } from '../src/paths.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

describe('projects', () => {
  test('a path that is not a directory is refused with the path', async () => {
    const client = await harness.connect();
    const missing = join(harness.dataDir, 'nope', 'still-nope');
    let failure = 'none';
    try {
      await client.call('projects.add', { path: missing });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toBe('a project path must be an existing directory');
  });

  test('adding the same path twice returns the same project', async () => {
    const client = await harness.connect();
    const first = await client.call('projects.add', { path: harness.dataDir });
    const second = await client.call('projects.add', { path: harness.dataDir });
    expect(second.id).toBe(first.id);
    expect((await client.call('projects.list', {})).length).toBe(1);
  });
});

describe('settings', () => {
  test('settings survive a write and keep their defaults', async () => {
    const client = await harness.connect();
    const defaults = await client.call('settings.get', {});
    expect(defaults).toEqual({
      maxConcurrentTurns: 6,
      perAccountConcurrency: 2,
      warmProcessMinutes: 0,
      listenOnLan: false,
      agentCpuCapPercent: 75,
      threadMemoryCapMb: 0,
      focusGuard: true,
      muteAgents: true,
    });

    const next = await client.call('settings.set', { maxConcurrentTurns: 3 });
    expect(next.maxConcurrentTurns).toBe(3);
    expect(next.perAccountConcurrency).toBe(2);
    expect((await client.call('settings.get', {})).maxConcurrentTurns).toBe(3);

    let failure = 'none';
    try {
      await client.call('settings.set', { maxConcurrentTurns: -1 });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toContain('maxConcurrentTurns');
  });

  test('focusGuard is a boolean, on by default, and a change reaches every client', async () => {
    const client = await harness.connect();
    expect((await client.call('settings.get', {})).focusGuard).toBe(true);

    const updated = client.next('settings.updated', (settings) => settings.focusGuard === false, 5000);
    const next = await client.call('settings.set', { focusGuard: false });
    expect(next.focusGuard).toBe(false);
    expect((await updated).focusGuard).toBe(false);
    expect((await client.call('settings.get', {})).focusGuard).toBe(false);

    let failure = 'none';
    try {
      await client.call('settings.set', { focusGuard: 'yes' as unknown as boolean });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toBe('focusGuard must be a boolean');
  });

  test('muteAgents is a boolean, on by default, and a change reaches every client', async () => {
    const client = await harness.connect();
    expect((await client.call('settings.get', {})).muteAgents).toBe(true);

    const updated = client.next('settings.updated', (settings) => settings.muteAgents === false, 5000);
    const next = await client.call('settings.set', { muteAgents: false });
    expect(next.muteAgents).toBe(false);
    expect((await updated).muteAgents).toBe(false);
    expect((await client.call('settings.get', {})).muteAgents).toBe(false);

    let failure = 'none';
    try {
      await client.call('settings.set', { muteAgents: 'quiet' as unknown as boolean });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toBe('muteAgents must be a boolean');
  });
});

describe('usage', () => {
  test('usage.get sums the turns of a thread', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'one two three' });
    await finished;

    const usage = await client.call('usage.get', { threadId });
    expect(usage.byThread[threadId]?.outputTokens).toBe(3);
    expect(usage.total.inputTokens).toBe(3);
    expect(usage.total.costUsdEquivalent).toBeNull();
  });
});

describe('ids and flags', () => {
  test('newId prefixes twenty base32 characters', () => {
    const id = newId('thr_');
    expect(id.startsWith('thr_')).toBe(true);
    expect(id.slice(4)).toMatch(/^[0-9a-hjkmnp-tv-z]{20}$/);
    expect(newId('thr_')).not.toBe(id);
  });

  test('the flags follow the documented defaults', () => {
    expect(parseFlags([])).toEqual({
      port: 0,
      host: '127.0.0.1',
      hostExplicit: false,
      dataDir: undefined,
      channel: 'stable',
    });
    expect(parseFlags(['--port', '8080', '--lan'])).toEqual({
      port: 8080,
      host: '0.0.0.0',
      hostExplicit: true,
      dataDir: undefined,
      channel: 'stable',
    });
    expect(parseFlags(['--host', '10.0.0.2', '--data-dir', 'D:/data'])).toEqual({
      port: 0,
      host: '10.0.0.2',
      hostExplicit: true,
      dataDir: 'D:/data',
      channel: 'stable',
    });
  });

  test('--channel takes stable or dev and refuses anything else by name', () => {
    expect(parseFlags(['--channel', 'dev']).channel).toBe('dev');
    expect(parseFlags(['--channel', 'stable']).channel).toBe('stable');

    let failure = 'none';
    try {
      parseFlags(['--channel', 'foo']);
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toBe('--channel expects stable or dev, got foo');

    failure = 'none';
    try {
      parseFlags(['--channel']);
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toBe('--channel expects stable or dev, got (nothing)');
  });
});

describe('the data directory', () => {
  // The dev install lives beside the stable one and never inside it. Nothing
  // here writes anywhere: the default is a string until someone opens it.
  test('each channel owns a directory name on every OS', () => {
    expect(dataDirName('stable')).toBe('boite2');
    expect(dataDirName('dev')).toBe('boite2-dev');
  });

  test('with no override and no environment the channel decides', () => {
    const previous = process.env.BOITE_DATA_DIR;
    delete process.env.BOITE_DATA_DIR;
    try {
      expect(resolveDataDir(undefined, 'stable').endsWith(`${sep}boite2`)).toBe(true);
      expect(resolveDataDir(undefined, 'dev').endsWith(`${sep}boite2-dev`)).toBe(true);
      expect(resolveDataDir()).toBe(defaultDataDir('stable'));
    } finally {
      if (previous === undefined) delete process.env.BOITE_DATA_DIR;
      else process.env.BOITE_DATA_DIR = previous;
    }
  });

  test('--data-dir wins over the environment, which wins over the channel', () => {
    const previous = process.env.BOITE_DATA_DIR;
    process.env.BOITE_DATA_DIR = join('D:', 'from-env');
    try {
      expect(resolveDataDir(join('D:', 'from-flag'), 'dev')).toBe(join('D:', 'from-flag'));
      expect(resolveDataDir(undefined, 'dev')).toBe(join('D:', 'from-env'));
    } finally {
      if (previous === undefined) delete process.env.BOITE_DATA_DIR;
      else process.env.BOITE_DATA_DIR = previous;
    }
  });
});

describe('the bind address', () => {
  // Nothing here binds anything: resolveHost is the whole decision, and a test
  // that actually listened on 0.0.0.0 would ask the user for a firewall dialog.
  test('with no flag the listenOnLan setting decides the bind', () => {
    expect(resolveHost(parseFlags([]), { ...DEFAULT_SETTINGS, listenOnLan: false })).toBe('127.0.0.1');
    expect(resolveHost(parseFlags([]), { ...DEFAULT_SETTINGS, listenOnLan: true })).toBe('0.0.0.0');
  });

  test('an explicit --host or --lan wins over the setting', () => {
    expect(
      resolveHost(parseFlags(['--host', '127.0.0.1']), { ...DEFAULT_SETTINGS, listenOnLan: true }),
    ).toBe('127.0.0.1');
    expect(resolveHost(parseFlags(['--lan']), { ...DEFAULT_SETTINGS, listenOnLan: false })).toBe('0.0.0.0');
  });
});
