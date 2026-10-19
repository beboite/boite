import { GOAL_CHECKLIST_MAX_ITEMS, GOAL_CHECKLIST_SOURCE_MAX, GOAL_CHECKLIST_TEXT_MAX } from '@boite/contracts';
import type { GoalChecklistItem, Message } from '@boite/contracts';
import { activityResult } from './activity-prompt.ts';

/*
 * The prompts of a `/goal2` tracker and the reading of its answers. A tracker
 * pass answers with one JSON block; anything else in it is ignored.
 */

const HEAD = 'You keep the checklist of what the user asked for in a Boite goal. Another agent does the work; you only keep the list. Use no tool: answer from the text below.';

const RULES = `Rules for items:
- One item per distinct thing the user asks for. A sentence that asks for two things gives two items. Keep every request, even a small, vague or passing one.
- Read the user's corrections as meant: "or rather", "actually", "but", "att" and a word followed by * replace what came before. Keep the final meaning, never its opposite.
- A constraint on the result ("do not change the save format") is an item. How the agent should organise its work (subagents, worktrees, commits) is not.
- Never invent work the user did not ask for, and do not split a request into implementation steps.
- text: in the user's language, at most 12 words, starting with a verb, the visible result in plain words. No file paths or code names: someone who forgot the conversation must understand it.
- When the request points at an attached image, end the text with "(image N)".
- source: the exact words of the user's message the item comes from, at most 200 characters.`;

const END = 'End your answer with one fenced json block and nothing after it:';

/** The first pass: the objective becomes the list. */
export function writePrompt(objective: string): string {
  return `${HEAD}

${RULES}

The user's objective, supplied as JSON data:
${JSON.stringify(objective)}

${END}
\`\`\`json
{"items":[{"text":"...","source":"..."}]}
\`\`\``;
}

/** A later message of the user: what it adds, drops or changes. */
export function updatePrompt(items: GoalChecklistItem[], messages: string[]): string {
  const current = items.map(({ id, text, status }) => ({ id, text, status }));
  return `${HEAD}

The user sent new messages while the agent works. Update the checklist:
- A new request becomes a new item.
- A message that drops an item cancels it.
- A message that changes an item changes it: give its new text.
- A message that only answers a question, thanks the agent or comments on the work changes nothing.

${RULES}

The current checklist, supplied as JSON data:
${JSON.stringify(current)}

The new messages, oldest first, supplied as JSON data:
${JSON.stringify(messages)}

${END} (empty lists when nothing changes)
\`\`\`json
{"add":[{"text":"...","source":"..."}],"cancel":[3],"change":[{"id":4,"text":"...","source":"..."}]}
\`\`\``;
}

/** After the agent's turn: which open items it did. */
export function checkPrompt(items: GoalChecklistItem[], digest: TurnDigest): string {
  const open = items.filter(item => item.status === 'open').map(({ id, text }) => ({ id, text }));
  return `You keep the checklist of what the user asked for in a Boite goal. The agent working on it just finished a turn. Say which open items that turn did. Use no tool: judge only from the report below.
You skim, you do not review. An item is done when the turn's actions clearly did it and the agent's answer agrees. An item the actions never touched stays open, even when the agent claims it. When unsure, leave it open.

The open items, supplied as JSON data:
${JSON.stringify(open)}

What the agent did in that turn, supplied as JSON data. The answer is a claim, not evidence:
${JSON.stringify(digest)}

${END}
\`\`\`json
{"done":[1,4]}
\`\`\``;
}

/** The rules every tracker conversation starts with, on every agent. */
export const TRACKER_RULES = 'You keep a Boite goal\'s checklist. Answer only from the text each message gives you. Do not run commands, read or edit files, start subagents or message anyone.';

/** What a turn did, as a tracker reads it: its tool calls in one line each and the agent's last answer. */
export interface TurnDigest {
  actions: string[];
  answer: string;
}

const ACTIONS_MAX = 120;
const ACTION_CHARS = 200;
const ANSWER_CHARS = 4000;

/** One line per tool call, the failed ones marked, then the last assistant text without goal markers. */
export function turnDigest(messages: Iterable<Message>): TurnDigest {
  const actions: string[] = [];
  let answer = '';
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const texts: string[] = [];
    for (const part of message.parts) {
      if (part.type === 'text') texts.push(part.text);
      if (part.type !== 'tool') continue;
      const failed = part.status === 'error' || (typeof part.exitCode === 'number' && part.exitCode !== 0);
      actions.push(`${toolLine(part.name, part.input)}${failed ? ' (failed)' : ''}`.slice(0, ACTION_CHARS));
    }
    const text = activityResult(texts.join('\n'));
    if (text) answer = text;
  }
  return { actions: actions.slice(-ACTIONS_MAX), answer: answer.slice(-ANSWER_CHARS) };
}

/** Several turns read as one: their actions in order and the last answer. */
export function joinDigests(digests: TurnDigest[]): TurnDigest {
  return { actions: digests.flatMap(digest => digest.actions).slice(-ACTIONS_MAX), answer: digests.findLast(digest => digest.answer)?.answer ?? '' };
}

function toolLine(name: string, input: unknown): string {
  const fields = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const path = [fields.file_path, fields.path, fields.filePath, fields.notebook_path].find(value => typeof value === 'string');
  if (typeof path === 'string') return `${name} ${path}`;
  const command = fields.command ?? fields.cmd;
  if (typeof command === 'string') return `${name}: ${command}`;
  if (Array.isArray(command)) return `${name}: ${command.filter(word => typeof word === 'string').join(' ')}`;
  const patch = [fields.patch, fields.input].find(value => typeof value === 'string');
  if (typeof patch === 'string') {
    const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1]!.trim());
    if (files.length) return `${name} ${files.join(', ')}`;
  }
  return name;
}

/** The last JSON object of an answer: a fenced block first, else the last brace that parses. */
export function lastJson(text: string): Record<string, unknown> | null {
  const blocks = [...text.matchAll(/```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)```/g)].map(match => match[1]!);
  for (const block of blocks.reverse()) {
    const value = parseObject(block);
    if (value) return value;
  }
  const end = text.lastIndexOf('}');
  if (end < 0) return null;
  for (let start = text.lastIndexOf('{', end), tries = 0; start >= 0 && tries < 200; start = text.lastIndexOf('{', start - 1), tries++) {
    const value = parseObject(text.slice(start, end + 1));
    if (value) return value;
  }
  return null;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text.trim());
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

const clip = (value: unknown, max: number): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const ids = (value: unknown): number[] => Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id)) : [];

/** A written item without its id: what a write or an add gives. */
type Draft = Pick<GoalChecklistItem, 'text' | 'source'>;

function drafts(value: unknown): Draft[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    const row = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const text = clip(row.text, GOAL_CHECKLIST_TEXT_MAX);
    return text ? [{ text, source: clip(row.source, GOAL_CHECKLIST_SOURCE_MAX) }] : [];
  });
}

/** The list a first pass wrote, or the reason it is unusable. */
export function readWrite(answer: string): GoalChecklistItem[] | string {
  const json = lastJson(answer);
  if (!json || !Array.isArray(json.items)) return 'The tracker answered without a {"items": [...]} JSON block.';
  const items = drafts(json.items).slice(0, GOAL_CHECKLIST_MAX_ITEMS);
  if (!items.length) return 'The tracker wrote an empty checklist.';
  return items.map((item, index) => ({ id: index + 1, ...item, status: 'open' }));
}

/** The list after an update's additions, cancellations and changes, or the reason the answer is unusable. */
export function readUpdate(answer: string, items: GoalChecklistItem[]): GoalChecklistItem[] | string {
  const json = lastJson(answer);
  if (!json || !['add', 'cancel', 'change'].some(key => key in json)) return 'The tracker answered without an {"add", "cancel", "change"} JSON block.';
  const cancelled = new Set(ids(json.cancel));
  const changes = new Map<number, Draft>();
  for (const entry of Array.isArray(json.change) ? json.change : []) {
    const row = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const text = clip(row.text, GOAL_CHECKLIST_TEXT_MAX);
    if (Number.isInteger(row.id) && text) changes.set(row.id as number, { text, source: clip(row.source, GOAL_CHECKLIST_SOURCE_MAX) });
  }
  const next = items.map((item): GoalChecklistItem => {
    if (cancelled.has(item.id)) return { ...item, status: 'cancelled' };
    const change = changes.get(item.id);
    // A changed request is work again, whatever was done for the old one.
    return change && change.text !== item.text ? { ...item, ...change, source: change.source || item.source, status: 'open', changed: true, bounced: 0 } : item;
  });
  let id = Math.max(0, ...items.map(item => item.id));
  for (const draft of drafts(json.add)) next.push({ id: ++id, ...draft, status: 'open', added: true });
  return next.slice(0, GOAL_CHECKLIST_MAX_ITEMS);
}

/** The open items a check saw done, or the reason its answer is unusable. */
export function readCheck(answer: string, items: GoalChecklistItem[]): GoalChecklistItem[] | string {
  const json = lastJson(answer);
  if (!json || !Array.isArray(json.done)) return 'The tracker answered without a {"done": [...]} JSON block.';
  const done = new Set(ids(json.done));
  return items.map(item => item.status === 'open' && done.has(item.id) ? { ...item, status: 'done' } : item);
}
