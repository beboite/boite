/*
 * What a thread is called. A client sends the first line of the first prompt
 * on `threads.create`; after the first turn the agent's driver may say it
 * better (`Driver.title`), and `threads.retitle` asks again on demand. The
 * two cuts below are the whole vocabulary: one for a prompt, one for what an
 * agent answered, each bounded so a sidebar row never carries a paragraph.
 */

import type { Message } from '@boite/contracts';

/** What a title from a prompt is cut to, the same width a client uses on create. */
export const PROMPT_TITLE_MAX = 60;
/** What an agent's answer is cut to: a sentence, never a paragraph. */
export const AGENT_TITLE_MAX = 80;
/** How much of the prompt and the answer an agent is shown to write the title. */
export const TITLE_INPUT_MAX = 2000;

/** The text parts of a message, joined. Images, tools and thinking are not words. */
export function textOf(message: Message): string {
  return message.parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

/**
 * The first line of a prompt, cut at a word when it runs past the width.
 * Empty when the prompt has no word: the caller keeps the title it had.
 */
export function titleFromPrompt(prompt: string, max = PROMPT_TITLE_MAX): string {
  const line = prompt
    .split('\n')
    .map((candidate) => candidate.replace(/^\s*#+\s*/, '').trim())
    .find((candidate) => candidate.length > 0);
  if (line === undefined) return '';
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const atWord = cut.lastIndexOf(' ');
  return (atWord > max / 2 ? cut.slice(0, atWord) : cut).trimEnd();
}

/**
 * An agent's answer as a title: the first line, quotes and a closing period
 * taken off, cut at a word. Null when nothing is left, so the caller falls
 * back instead of saving an empty title.
 */
export function cleanAgentTitle(answer: string, max = AGENT_TITLE_MAX): string | null {
  const line = answer
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (line === undefined) return null;
  const unquoted = line
    .replace(/^(?:title:\s*)/i, '')
    .replace(/^["'“‘`*_]+|["'”’`*_]+$/g, '')
    .replace(/[.]+$/, '')
    .trim();
  if (unquoted.length === 0) return null;
  if (unquoted.length <= max) return unquoted;
  const cut = unquoted.slice(0, max);
  const atWord = cut.lastIndexOf(' ');
  return (atWord > max / 2 ? cut.slice(0, atWord) : cut).trimEnd();
}

/** The prompt an agent is asked with: the exchange, bounded, and one instruction. */
export function titleRequest(prompt: string, answer: string): string {
  const user = prompt.length > TITLE_INPUT_MAX ? `${prompt.slice(0, TITLE_INPUT_MAX)} [cut]` : prompt;
  const assistant = answer.length > TITLE_INPUT_MAX ? `${answer.slice(0, TITLE_INPUT_MAX)} [cut]` : answer;
  return [
    'Write a title for the conversation below: at most six words, no quotes, no period, the same language as the user.',
    'Answer with the title alone.',
    '',
    '<user>',
    user,
    '</user>',
    '',
    '<assistant>',
    assistant.length > 0 ? assistant : '(no text)',
    '</assistant>',
  ].join('\n');
}
