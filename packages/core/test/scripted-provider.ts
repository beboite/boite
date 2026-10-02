import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OsProfile, ProviderDescriptor, RpcEvents } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import type { SpawnedChild } from '../src/procs.ts';

/** Deliver the captured child's final stderr after exit, before its delayed close. */
export function delayStderrAfterExit(child: SpawnedChild, ms: number, holdClose = false): () => void {
  const stderrEmit = child.stderr.emit.bind(child.stderr), childEmit = child.emit.bind(child);
  const held: unknown[][] = [];
  let close: unknown[] | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let closeReady = false;
  const drain = (releaseClose = true): void => {
    for (const args of held.splice(0)) stderrEmit('data', ...args);
    closeReady ||= releaseClose;
    if (closeReady && close) { const args = close; close = undefined; childEmit('close', ...args); }
  };
  child.stderr.emit = (name: string | symbol, ...args: unknown[]) => {
    if (name !== 'data') return stderrEmit(name, ...args);
    held.push(args);
    return true;
  };
  child.emit = (name: string | symbol, ...args: unknown[]) => {
    if (name === 'close' && !closeReady) { close = args; return true; }
    const emitted = childEmit(name, ...args);
    if (name === 'exit') timer = setTimeout(() => drain(!holdClose), ms);
    return emitted;
  };
  return () => {
    clearTimeout(timer);
    child.stderr.emit = stderrEmit;
    child.emit = childEmit;
    drain();
  };
}

/** Only launch/filesystem plumbing; each test authors its own descriptor data. */
export function writeScriptedProvider(dataDir: string, script: string, descriptor: Omit<ProviderDescriptor, 'profiles'>): void {
  const profile: OsProfile = {
    detect: {},
    executable: [{ kind: 'path', value: 'bun' }],
    launch: { args: [script] },
    isolation: {},
  };
  const dir = join(dataDir, 'providers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${descriptor.id}.json`),
    JSON.stringify({
      ...descriptor,
      profiles: { windows: profile, linux: profile, macos: profile },
    }),
    'utf8',
  );
}

export function readScriptedLog(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

export function countLogLines(text: string, line: string): number {
  return text
    .split('\n')
    .filter(entry => entry === line).length;
}

export function countProcesses(
  client: CoreClient,
  threadId: string,
): { started: RpcEvents['process.started'][]; exited: RpcEvents['process.exited'][] } {
  const started: RpcEvents['process.started'][] = [];
  const exited: RpcEvents['process.exited'][] = [];
  client.on('process.started', (record) => {
    if (record.threadId === threadId) started.push(record);
  });
  client.on('process.exited', (record) => {
    if (record.threadId === threadId) exited.push(record);
  });
  return { started, exited };
}
