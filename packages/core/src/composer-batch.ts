import { composerBatch as batch, type ComposerQueuedPrompt } from '@boite/contracts';
import { digest, type ComposerStorage } from './composer-storage.ts';

/** Runtime request ids retain the durable ledger's existing digest. */
export function composerBatch(queue: ComposerQueuedPrompt[], storage: ComposerStorage) {
  const result = batch(queue, id => storage.readAsset(id));
  const first = queue[0]!;
  const requestId = first.request?.id && /^[A-Za-z0-9_-]{8,128}$/.test(first.request.id)
    ? first.request.id : `composer_${digest(result.entries.map(item => item.id))}`;
  return { ...result, requestId };
}
