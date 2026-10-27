import { z } from 'zod';
import { previewReferencesError, type ComposerValue } from '@boite/contracts';
import { invalidParams } from './errors.ts';

const choice = z.object({
  providerId: z.string().min(1), accountId: z.string().min(1),
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'yolo', 'plan', 'dontAsk']),
  model: z.string().nullable(), effort: z.string().nullable(), speed: z.string().nullable().optional(),
});
const attachment = z.object({ kind: z.enum(['image', 'file']), mimeType: z.string(), name: z.string().nullable(), assetId: z.string().min(1) });
// The preview validator below is shared with turns.start, including mention offsets.
const references = z.array(z.unknown()).optional();
const queued = z.object({
  id: z.string().min(1), text: z.string(), attachments: z.array(attachment), previewReferences: references,
  afterBoundary: z.string().optional(), choice: choice.optional(),
  request: z.object({ id: z.string().min(1), choice: choice.nullable(), queuedAt: z.number().finite(), failed: z.string().optional(), sent: z.literal(true).optional(),
    start: z.object({ projectId: z.string().min(1), worktree: z.boolean(), incognito: z.boolean() }).optional() }).optional(),
});
const schema = z.object({
  input: z.object({ text: z.string(), attachments: z.array(attachment), previewReferences: references, queued: z.array(queued), paused: z.boolean(), editing: z.string().nullable().optional() }),
  draft: z.object({ id: z.string().optional(), createdAt: z.number().finite().optional(), projectId: z.string().nullable(), worktree: z.boolean(), worktreeExplicit: z.literal(true).optional(), incognito: z.literal(true).optional() }).optional(),
  choice: choice.nullable().optional(), parked: z.number().finite().optional(),
});

/** Strip client-only transient state and reject malformed records before a CAS write. */
export function composerValue(value: unknown): ComposerValue | null {
  if (value === null) return null;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidParams(`composer.value: ${parsed.error.message}`);
  const result = parsed.data as ComposerValue;
  for (const input of [result.input, ...result.input.queued]) {
    const error = previewReferencesError(input.previewReferences ?? [], input.text);
    if (error) throw invalidParams(`composer.value.previewReferences: ${error}`);
  }
  if (new Set(result.input.queued.map(item => item.id)).size !== result.input.queued.length) throw invalidParams('composer.value.input.queued: expected unique item ids');
  return result;
}
