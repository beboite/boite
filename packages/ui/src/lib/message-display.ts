import type { Message, MessagePart } from '@boite/contracts';

/** Older cores journalled the whole goal instruction as a user message. */
export function visibleUserText(text: string): string {
  const legacy = /^Work toward this goal: ([\s\S]*?)\r?\nContinue until the objective is achieved\./.exec(text);
  return legacy ? `/goal ${legacy[1]}` : text;
}

/** Hide protocol-only lines, including a marker that is still streaming. */
export function visibleAnswer(text: string): string {
  const clean = text.replace(/^[\t ]*\[BOITE_GOAL_(?:COMPLETE|BLOCKED)\][\t ]*(?:\r?\n|$)/gm, '');
  const lastLine = clean.slice(clean.lastIndexOf('\n') + 1).trimStart();
  if (lastLine.startsWith('[BOITE') && ['[BOITE_GOAL_COMPLETE]', '[BOITE_GOAL_BLOCKED]'].some(marker => marker.startsWith(lastLine))) return clean.slice(0, clean.lastIndexOf('\n') + 1);
  return clean;
}

export function messagePreview(message: Message): string {
  return message.parts.filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text').map(part => visibleUserText(part.text)).join(' ').trim();
}
