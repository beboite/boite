import { ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES, PREVIEW_REFERENCES_PER_TURN, decodedBytes, type Attachment, type ComposerQueuedPrompt, type PreviewReference } from '@boite/contracts';
import { isComposerActivity } from './composer-activity.ts';
import { digest, type ComposerStorage } from './composer-storage.ts';

export interface ComposerBatch {
  entries: ComposerQueuedPrompt[];
  text: string;
  attachments: Attachment[];
  previewReferences: PreviewReference[];
  requestId: string;
}

/** Adjacent ordinary prompts share one submission, within the existing turn limits. */
export function composerBatch(queue: ComposerQueuedPrompt[], storage: ComposerStorage): ComposerBatch {
  const first = queue[0]!;
  const result: ComposerBatch = { entries: [], text: '', attachments: [], previewReferences: [], requestId: '' };
  let bytes = 0;
  const ids = new Set<string>();
  const choice = (item: ComposerQueuedPrompt) => digest({ ...item.choice, speed: item.choice?.speed ?? null });
  // The batch is decided from its first prompt's experiments, so a prompt queued with Automatic goals in another state goes alone.
  const autoGoal = (item: ComposerQueuedPrompt) => item.experiments?.includes('auto-goal') ?? false;
  for (const item of queue) {
    if (result.entries.length && (first.request || item.request || isComposerActivity(first.text) || isComposerActivity(item.text) || choice(first) !== choice(item) || digest(first.sentFrom ?? null) !== digest(item.sentFrom ?? null) || item.afterBoundary !== first.afterBoundary || autoGoal(first) !== autoGoal(item))) break;
    const attachments = item.attachments.map(reference => storage.readAsset(reference.assetId));
    const weight = attachments.reduce((sum, attachment) => sum + decodedBytes(attachment.data), 0);
    if (result.entries.length && (result.attachments.length + attachments.length > ATTACHMENTS_PER_TURN || bytes + weight > ATTACHMENTS_TOTAL_MAX_BYTES || result.previewReferences.length + (item.previewReferences?.length ?? 0) > PREVIEW_REFERENCES_PER_TURN)) break;
    if (result.entries.length) result.text += '\n\n';
    const offset = result.text.length;
    result.text += item.text;
    result.entries.push(item);
    result.attachments.push(...attachments); bytes += weight;
    for (const reference of item.previewReferences ?? []) {
      let id = reference.id, suffix = 0;
      while (ids.has(id)) id = `${reference.id.slice(0, 60)}-queue-${++suffix}`;
      ids.add(id);
      result.previewReferences.push({ ...reference, id, ...(reference.mention ? { mention: { start: reference.mention.start + offset, end: reference.mention.end + offset } } : {}) });
    }
  }
  result.requestId = first.request?.id && /^[A-Za-z0-9_-]{8,128}$/.test(first.request.id) ? first.request.id : `composer_${digest(result.entries.map(item => item.id))}`;
  return result;
}
