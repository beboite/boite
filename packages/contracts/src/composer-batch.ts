import { ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES } from './attachment-limits';
import { decodedBytes } from './attachment-validation';
import { PREVIEW_REFERENCES_PER_TURN } from './preview';
import type { Attachment, PreviewReference } from './messages';
import type { ComposerQueuedPrompt } from './composer';
import { isComposerActivity, stableComposerValue } from './composer-activity';

export interface ComposerBatch {
  entries: ComposerQueuedPrompt[];
  text: string;
  attachments: Attachment[];
  previewReferences: PreviewReference[];
}

/** Adjacent ordinary prompts share one submission, within the existing turn limits. */
export function composerBatch(queue: ComposerQueuedPrompt[], readAsset: (assetId: string) => Attachment): ComposerBatch {
  const first = queue[0]!;
  const result: ComposerBatch = { entries: [], text: '', attachments: [], previewReferences: [] };
  let bytes = 0;
  const ids = new Set<string>();
  const choice = (item: ComposerQueuedPrompt) => stableComposerValue({ ...item.choice, speed: item.choice?.speed ?? null });
  const autoGoal = (item: ComposerQueuedPrompt) => item.experiments?.includes('auto-goal') ?? false;
  for (const item of queue) {
    if (result.entries.length && (first.request || item.request || isComposerActivity(first.text) || isComposerActivity(item.text) || choice(first) !== choice(item) || stableComposerValue(first.sentFrom ?? null) !== stableComposerValue(item.sentFrom ?? null) || item.afterBoundary !== first.afterBoundary || autoGoal(first) !== autoGoal(item))) break;
    const attachments = item.attachments.map(reference => readAsset(reference.assetId));
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
  return result;
}
