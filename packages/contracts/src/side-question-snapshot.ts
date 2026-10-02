import type { Message } from './index.ts';

/** The exact bounded, tool-observed context a side answer and its optional fork share. */
export function sideQuestionSnapshot(messages: Iterable<Message>): Message[] {
  const snapshot: Message[] = [];
  let size = 0, cut = false;
  for (const message of messages) {
    const text = message.parts.map(part => {
      if (part.type === 'text') return part.text;
      if (part.type === 'tool') return `[${part.name}] ${JSON.stringify(part.input)}\n${part.output ?? ''}`;
      return '';
    }).filter(Boolean).join('\n');
    if (!text) continue;
    const copy: Message = { ...message, parts: [{ type: 'text', text }], state: 'complete' };
    snapshot.push(copy);
    size += text.length;
    while (snapshot.length > 512) { size -= (snapshot.shift()!.parts[0] as { text: string }).text.length; cut = true; }
    while (size > 120_000) {
      cut = true;
      const first = snapshot[0]!, part = first.parts[0]!;
      if (part.type !== 'text') break;
      const excess = size - 120_000;
      if (part.text.length <= excess) { size -= part.text.length; snapshot.shift(); }
      else { part.text = part.text.slice(excess); size -= excess; }
    }
  }
  if (cut && snapshot.length) {
    const part = snapshot[0]!.parts[0]!;
    if (part.type === 'text') part.text = `[Earlier context was omitted to fit this request.]\n${part.text}`;
  }
  return snapshot;
}
