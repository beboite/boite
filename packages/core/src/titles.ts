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
/**
 * What an agent's answer is cut to. The model is asked for under 40
 * characters, one sidebar line; this is the bound when it writes more.
 */
export const AGENT_TITLE_MAX = 60;
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
export function titleRequest(prompt: string, answer: string, initial = false): string {
  const user = limitTitleInput(prompt);
  const assistant = limitTitleInput(answer);
  return [
    'Write a short title for the conversation below, one line of a sidebar: 2 to 6 words, fewer than 40 characters.',
    'Name the task itself. No quotes, no trailing period, no emoji, the same language as the user.',
    'Title the user\'s subject and desired outcome. Use the assistant only to resolve an unnamed subject, never to replace the user\'s goal with an incidental finding.',
    'Return JSON with keys title (string) and needsRefinement (boolean).',
    initial
      ? 'Set needsRefinement to true only when the subject is still unknown, such as an unresolved link, "fix this", or an unexplained attachment. Otherwise set it to false.'
      : 'Use the answer to resolve a vague subject. Set needsRefinement to false.',
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

/** Keep the original subject and final constraints or findings when an exchange exceeds the title budget. */
function limitTitleInput(text: string): string {
  if (text.length <= TITLE_INPUT_MAX) return text;
  const marker = '\n[cut]\n';
  const half = Math.floor((TITLE_INPUT_MAX - marker.length) / 2);
  return text.slice(0, half) + marker + text.slice(-(TITLE_INPUT_MAX - marker.length - half));
}

/** Structured answers carry the refinement decision; older hooks may still return a plain title. */
export function parseAgentTitle(raw: string): { title: string; needsRefinement: boolean } | null {
  const text = raw.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
  if (!text.startsWith('{')) {
    const title = cleanAgentTitle(text);
    return title === null ? null : { title, needsRefinement: false };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || !('title' in value) || typeof value.title !== 'string') return null;
    if ('needsRefinement' in value && typeof value.needsRefinement !== 'boolean') return null;
    const title = cleanAgentTitle(value.title);
    return title === null ? null : { title, needsRefinement: 'needsRefinement' in value && value.needsRefinement === true };
  } catch {
    return null;
  }
}
