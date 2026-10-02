import type { Message } from './index';

/** Folded tools need their label and error preview, not megabytes of command output. */
export const TOOL_OUTPUT_INLINE_CHARS = 16 * 1024;
export const TOOL_OUTPUT_PREVIEW_CHARS = 1024;

/** Project snapshots only. Inputs, diffs, documents and live tool output remain complete. */
export function previewToolOutputs(messages: readonly Message[]): Message[] {
  return messages.map(message => {
    let changed = false;
    const parts = message.parts.map(part => {
      if (part.type !== 'tool' || part.status === 'running' || part.outputDeferred || (part.output?.length ?? 0) <= TOOL_OUTPUT_INLINE_CHARS) return part;
      changed = true;
      // A slice can retain the original megabytes in V8. Flatten the bounded
      // preview before keeping it in a browser's reading cache.
      const output = part.output!.slice(0, TOOL_OUTPUT_PREVIEW_CHARS).split('').join('');
      return { ...part, output, outputDeferred: true as const };
    });
    return changed ? { ...message, parts } : message;
  });
}
