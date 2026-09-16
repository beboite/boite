import type { MessagePart } from '@boite/contracts';

const GOAL_SUFFIX = '\nContinue until the objective is achieved. When you have verified completion, write [BOITE_GOAL_COMPLETE] alone on its own line. If blocked or waiting for user input, explain what is missing and write [BOITE_GOAL_BLOCKED] alone on its own line.';

export function promptText(part: Extract<MessagePart, { type: 'text' }>): string {
  if (part.displayText !== undefined) return part.displayText;
  if (part.text.startsWith('Work toward this goal: ') && part.text.endsWith(GOAL_SUFFIX)) {
    return '/goal ' + part.text.slice('Work toward this goal: '.length, -GOAL_SUFFIX.length);
  }
  return part.text;
}

export function answerText(text: string, live: boolean): string {
  const clean = text.replace(/^[ \t]*\[BOITE_GOAL_(?:COMPLETE|BLOCKED)\][ \t]*(?:\r?\n|$)/gm, '');
  return live ? clean.replace(/(?:^|\n)[ \t]*\[BOITE_[^\n]*$/, '') : clean;
}

/** Only complete paragraphs and fenced blocks enter the timeline while streaming. */
export function paragraphBlocks(text: string, live: boolean): string[] {
  const blocks: string[] = [];
  let start = 0;
  let offset = 0;
  let fence = '';
  for (const line of text.split(/(?<=\n)/)) {
    const trimmed = line.trim();
    const marker = /^(?:`{3,}|~{3,})/.exec(trimmed)?.[0];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && trimmed === marker) fence = '';
    }
    offset += line.length;
    if (!fence && !trimmed && line.endsWith('\n')) {
      const block = text.slice(start, offset).trim();
      if (block) blocks.push(block);
      start = offset;
    }
  }
  if (!live && text.slice(start).trim()) blocks.push(text.slice(start).trim());
  return blocks;
}

/** Codex can append several bold thought headings inside the same part. */
export function currentThought(text: string): { title: string | null; text: string } {
  const headings = [...text.matchAll(/\*\*([^*\n]+)\*\*/g)];
  const last = headings.at(-1);
  return { title: last?.[1]?.trim() ?? null, text: last ? text.slice(last.index) : text };
}
