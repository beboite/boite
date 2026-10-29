import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { MessagePart } from '@boite/contracts';
import type { CoreClient } from '../src/client.ts';
import { MemoryVault } from '../src/platform/secret-vault.ts';
import { waitFor, type TestCore } from './harness.ts';

/** A memory vault that keeps what crossed it, so a test sees the buffers zeroed and the entries gone. */
export class SpyVault extends MemoryVault {
  override readonly persistent: boolean;
  readonly given: Uint8Array[] = [];
  readonly taken: Uint8Array[] = [];
  /** While set, a put waits on it: a test closes the card mid-store. */
  hold: Promise<void> | null = null;
  constructor(persistent = false) {
    super();
    this.persistent = persistent;
  }
  override async put(id: string, value: Uint8Array): Promise<void> {
    this.given.push(value);
    await this.hold;
    await super.put(id, value);
  }
  override async take(id: string): Promise<Uint8Array | null> {
    const value = await super.take(id);
    if (value !== null) this.taken.push(value);
    return value;
  }
}

/** A value with characters URL encoding changes, unique to the test. */
export function secretValue(): string {
  return `sk-te$t/Ü+${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/** The files under `dir` holding the value raw, as UTF-16 or URL-encoded; `skip` names folders a test wrote it to on purpose. */
export async function leaks(h: TestCore, value: string, skip: string[] = []): Promise<string[]> {
  await h.core.logs.flush();
  const forms = [Buffer.from(value), Buffer.from(value, 'utf16le'), Buffer.from(encodeURIComponent(value))];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (skip.some(folder => path.startsWith(folder))) continue;
      if (entry.isDirectory()) { walk(path); continue; }
      let bytes: Buffer;
      try { bytes = readFileSync(path); } catch { continue; }
      if (forms.some(form => bytes.includes(form))) found.push(relative(h.dataDir, path));
    }
  };
  walk(h.dataDir);
  return found;
}

export function cardPart(h: TestCore, threadId: string, requestId: string): Extract<MessagePart, { type: 'secret_request' }> | undefined {
  return h.core.journal.listMessages(threadId).flatMap(message => message.parts)
    .find((part): part is Extract<MessagePart, { type: 'secret_request' }> => part.type === 'secret_request' && part.requestId === requestId);
}

/** Starts a turn that runs until stopped: a card opens only while one does. */
export async function holdTurn(h: TestCore, owner: CoreClient, threadId: string): Promise<void> {
  await owner.call('turns.start', { threadId, prompt: '[sleep:600000]' });
  await waitFor(() => h.core.journal.runningTurn(threadId) !== null);
}

export async function stopTurn(h: TestCore, owner: CoreClient, threadId: string): Promise<void> {
  await owner.call('turns.stop', { threadId });
  await waitFor(() => h.core.journal.runningTurn(threadId) === null);
}

/** `boite secret ask` from `client`; resolves once the card is drawn, with the call still waiting for the answer. */
export async function openCard(h: TestCore, client: CoreClient, threadId: string, name: string, extra: { requestId?: string } = {}) {
  const requestId = extra.requestId ?? `sreq_${crypto.randomUUID().replaceAll('-', '')}`;
  const asked = client.call('secrets.ask', { threadId, name, reason: 'to call the API in the tests', requestId });
  // A refusal before the card is drawn fails the wait, not a later tick.
  let failure: unknown = null;
  asked.catch((error: unknown) => { failure = error; });
  await waitFor(() => {
    if (failure !== null) throw failure;
    return cardPart(h, threadId, requestId)?.status === 'pending';
  });
  return { requestId, asked };
}

/** Asks, answers with `value` from `owner` and gives back the ref. */
export async function saveSecret(h: TestCore, owner: CoreClient, threadId: string, name: string, value: string): Promise<string> {
  const { requestId, asked } = await openCard(h, owner, threadId, name);
  await owner.call('secrets.answer', { threadId, requestId, value });
  const result = await asked;
  if (result.outcome !== 'saved' || result.ref === null) throw new Error(`the card closed as ${result.outcome}`);
  return result.ref;
}
