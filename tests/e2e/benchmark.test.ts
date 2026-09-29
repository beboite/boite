import { expect, spyOn, test } from 'bun:test';
import { existsSync } from 'node:fs';
import * as clients from '../../packages/core/src/client.ts';
import * as cores from './lib/core.ts';
import { echoTurns } from '../../bench/boite2.ts';
import { pidAlive, RssSampler } from '../../bench/lib/proc.ts';

test('a rejected benchmark turn closes its core, sampler and temporary project', async () => {
  let running: cores.RunningCore | undefined;
  let client: clients.CoreClient | undefined;
  let projectDirectory: string | undefined;
  let samplerStopped = false;
  const startCore = cores.startCore;
  const connect = clients.connect;
  const start = spyOn(cores, 'startCore').mockImplementation(async options => {
    running = await startCore(options);
    return running;
  });
  const connection = spyOn(clients, 'connect').mockImplementation(async (...args) => {
    client = await connect(...args);
    const call = client.call.bind(client);
    spyOn(client, 'call').mockImplementation((method, params) => {
      if (method === 'projects.add') projectDirectory = (params as { path: string }).path;
      if (method === 'turns.start') return Promise.reject(new Error('benchmark start rejected'));
      return call(method, params);
    });
    return client;
  });
  const sampler = spyOn(RssSampler, 'start').mockReturnValue({
    async stop() { samplerStopped = true; return []; },
  } as unknown as RssSampler);
  try {
    await expect(echoTurns(2, 3, 5)).rejects.toThrow('benchmark start rejected');
    expect(samplerStopped).toBe(true);
    expect(running).toBeDefined();
    expect(pidAlive(running!.pid)).toBe(false);
    expect(existsSync(running!.dataDir)).toBe(false);
    expect(projectDirectory).toBeDefined();
    expect(existsSync(projectDirectory!)).toBe(false);
  } finally {
    client?.close();
    await running?.stop();
    if (projectDirectory) await cores.removeDirectory(projectDirectory);
    start.mockRestore();
    connection.mockRestore();
    sampler.mockRestore();
  }
}, 30_000);
