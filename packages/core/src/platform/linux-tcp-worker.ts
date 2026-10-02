import { readFileSync, readdirSync } from 'node:fs';
import { LinuxTcp } from './linux-tcp.ts';
import type { LinuxResourceProcess } from './linux-resources.ts';
import type { ResourceByteUsage } from '@boite/contracts';

export type TcpWorkerCommand =
  | { kind: 'sample'; id: number; members: [string, LinuxResourceProcess[]][] }
  | { kind: 'forget'; threadId: string }
  | { kind: 'stop' };
export type TcpWorkerReply =
  | { kind: 'sample'; id: number; samples: [string, ResourceByteUsage][] }
  | { kind: 'stopped' };

const scope = globalThis as unknown as {
  onmessage: ((event: { data: TcpWorkerCommand }) => void) | null;
  postMessage(message: TcpWorkerReply): void;
  close(): void;
};
const collector = new LinuxTcp(path => {
  try { return path.endsWith('/fd') ? readdirSync(path).join('\n') : readFileSync(path, 'utf8'); }
  catch { return null; }
});
collector.watch(true);
let stopped = false;
let pending = false;
scope.onmessage = ({ data }): void => {
  if (data.kind === 'stop') {
    stopped = true;
    collector.watch(false);
    scope.postMessage({ kind: 'stopped' });
    scope.close();
  } else if (data.kind === 'forget') collector.forget(data.threadId);
  else if (!stopped && !pending) {
    pending = true;
    const members = new Map(data.members);
    void collector.finish(members).then(() => {
      if (!stopped) scope.postMessage({ kind: 'sample', id: data.id,
        samples: [...members.keys()].map(threadId => [threadId, collector.sample(threadId)]) });
    }).finally(() => { pending = false; });
  }
};
