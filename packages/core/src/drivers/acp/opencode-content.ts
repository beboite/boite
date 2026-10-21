import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolCallContent } from '@agentclientprotocol/sdk';
import { object, list, text } from './opencode-controls.ts';

const MAX_TEXT = 64 * 1024;

/** Text stays output; attached images and completed file changes stay documents. */
export async function openCodeContent(content: unknown, metadata: unknown, cwd: string): Promise<ToolCallContent[]> {
  const parts = list(content).flatMap<ToolCallContent>(part => {
    if (part['type'] === 'text') return [{ type: 'content', content: { type: 'text', text: text(part['text']) } }];
    const image = /^data:(image\/[^;,]+);base64,(.*)$/.exec(text(part['uri']));
    return image ? [{ type: 'content', content: { type: 'image', mimeType: image[1]!, data: image[2]! } }] : [];
  });
  for (const file of list(object(metadata)['files'])) {
    const patch = text(file['patch']);
    if (!text(file['file']) || !patch || patch.length > MAX_TEXT) continue;
    const path = resolve(cwd, text(file['file']));
    let newText = '';
    if (file['status'] !== 'deleted') {
      const handle = await open(path, 'r').catch(() => null);
      if (!handle) continue;
      try {
        if ((await handle.stat()).size > MAX_TEXT) continue;
        const buffer = Buffer.alloc(MAX_TEXT + 1);
        const { bytesRead } = await handle.read(buffer);
        if (bytesRead > MAX_TEXT) continue;
        newText = buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await handle.close(); }
    }
    // Loaded only when the server reports a file change.
    const { applyPatch, parsePatch, reversePatch } = await import('diff');
    try {
      const parsed = parsePatch(patch)[0];
      const oldText = file['status'] === 'added' ? '' : parsed ? applyPatch(newText, reversePatch(parsed)) : false;
      if (oldText !== false && oldText.length + newText.length <= MAX_TEXT) parts.push({ type: 'diff', path, oldText, newText });
    } catch { /* A truncated server patch stays in its tool output. */ }
  }
  return parts;
}
