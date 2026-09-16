import type { Message, MessagePart } from '@boite/contracts';

/** Older cores journalled the whole goal instruction as a user message. */
export function visibleUserText(text: string): string {
  const legacy = /^Work toward this goal: ([\s\S]*?)\r?\nContinue until the objective is achieved\./.exec(text);
  return legacy ? `/goal ${legacy[1]}` : text;
}

/** Hide protocol-only lines, including a marker that is still streaming. */
export function visibleAnswer(text: string): string {
  const tail = /(?:^|\n)([\t ]*\[BOITE[^\r\n]*?)[\t ]*(?:\r?\n[\t ]*)*$/.exec(text);
  if (!tail) return text;
  const marker = tail[1]!.trim();
  if (!['[BOITE_GOAL_COMPLETE]', '[BOITE_GOAL_BLOCKED]'].some(value => value.startsWith(marker))) return text;
  const start = tail.index + (text[tail.index] === '\n' ? 1 : 0);
  // A terminal marker inside an unfinished fenced example is still answer content.
  let fence: string | null = null;
  for (const line of text.slice(0, start).split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const delimiter = match[1]!;
    if (!fence) fence = delimiter;
    else if (delimiter[0] === fence[0] && delimiter.length >= fence.length && !match[2]!.trim()) fence = null;
  }
  return fence ? text : text.slice(0, start);
}

export function messagePreview(message: Message): string {
  return message.parts.filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text').map(part => visibleUserText(part.text)).join(' ').trim();
}
