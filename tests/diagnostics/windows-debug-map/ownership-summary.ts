import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

/** Cross-thread transfers are resolved from both ledgers, never from handle values. */
export function summarizeOwnership(directory: string) {
  const failures: string[] = [], owners = new Map<string, {role: string; stopped: boolean}>();
  const acquired = new Set<string>(), sent = new Set<string>(), received = new Set<string>(), closed = new Set<string>();
  const intercepted = new Set<string>();
  let events = 0;
  for (const name of readdirSync(directory).filter(name => name.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(directory, name), 'utf8').split('\n').filter(Boolean)) {
      try {
        const e = JSON.parse(line); events++;
        if (e.event === 'owner-start') owners.set(e.owner, {role: e.role, stopped: false});
        if (e.event === 'owner-stop') {
          const owner = owners.get(e.owner); if (owner) owner.stopped = true;
          if (!e.complete || e.retained?.length) failures.push(`${name}: incomplete owner shutdown`);
        }
        if (e.event === 'incomplete') failures.push(`${name}: ${e.reason}`);
        if (e.event === 'interception-verified') intercepted.add(e.role);
        if (e.event === 'acquired') acquired.add(e.id);
        if (e.event === 'transfer-send') sent.add(e.transfer.id);
        if (e.event === 'transfer-received') {
          if (received.has(e.id)) failures.push(`${name}: duplicate transfer ${e.id}`);
          received.add(e.id);
        }
        if (e.event === 'close-result') {
          if (!e.success) failures.push(`${name}: original close failed ${e.id}`);
          else {
            if (closed.has(e.id)) failures.push(`${name}: repeated close ${e.id}`);
            closed.add(e.id);
          }
        }
      } catch {failures.push(`${name}: undecodable trace line`);}
    }
  }
  for (const role of ['launcher-main', 'harness-main'])
    if (!intercepted.has(role)) failures.push(`${role}: interception not verified`);
  for (const [owner, value] of owners) if (!value.stopped) failures.push(`${owner}: owner-stop missing`);
  for (const id of sent) if (!received.has(id)) failures.push(`${id}: pending worker-to-main transfer`);
  for (const id of received) if (!sent.has(id)) failures.push(`${id}: transfer acquisition missing`);
  for (const id of acquired) if (!closed.has(id)) failures.push(`${id}: successful closure missing`);
  for (const id of closed) if (!acquired.has(id)) failures.push(`${id}: closure acquisition missing`);
  return {complete: failures.length === 0, events, owners: [...owners.entries()], acquired: acquired.size,
    transferred: sent.size, received: received.size, closed: closed.size, failures};
}
