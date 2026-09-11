/*
 * Claude Code's transcripts: one JSON record per line under
 * `<config dir>/projects/<folder>/<session id>.jsonl`, the folder being the
 * working directory with every character outside [A-Za-z0-9] turned into `-`.
 * A prompt is a `user` record whose content is a string or carries a text
 * block; a `user` record made of `tool_result` blocks answers the assistant's
 * `tool_use`; each `assistant` record carries one content block (text,
 * thinking or tool_use) of a message several records share. Sidechain records
 * are subagents' and are left out. `ai-title` and `summary` records name the
 * session in the agent's own words.
 */

import { IMAGE_MIME_TYPES } from '@boite/contracts';
import type { ImageMimeType, MessagePart } from '@boite/contracts';

/** What one tool's output is cut to before it is journalled. */
export const TOOL_OUTPUT_MAX = 20_000;

/** One exchange of the transcript: the prompt and what the agent did with it. */
export interface TranscriptTurn {
  prompt: string;
  images: { mimeType: ImageMimeType; data: string }[];
  promptAt: number;
  /** The assistant's parts in order, text runs merged, every tool with its result. */
  parts: MessagePart[];
  answerAt: number | null;
  lastAt: number;
}

export interface Transcript {
  turns: TranscriptTurn[];
  /** The agent's own title, from the last `ai-title` or `summary` record. */
  agentTitle: string | null;
  /** The working directory the first prompt was sent from. */
  cwd: string | null;
  /** The model the last assistant record names. */
  model: string | null;
}

/** The folder name Claude Code files a working directory's sessions under. */
export function claudeProjectFolder(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

interface Record {
  type?: unknown;
  isSidechain?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  aiTitle?: unknown;
  summary?: unknown;
  message?: { content?: unknown; model?: unknown };
}

type Block = { type?: unknown; [key: string]: unknown };

function timeOf(record: Record): number {
  const parsed = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function blocksOf(content: unknown): Block[] {
  return Array.isArray(content) ? content.filter((block): block is Block => typeof block === 'object' && block !== null) : [];
}

/** The text of a tool result, its blocks joined, cut at the cap. */
function resultText(content: unknown): string {
  const text =
    typeof content === 'string'
      ? content
      : blocksOf(content)
          .map((block) => (block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : ''))
          .join('\n');
  return text.length > TOOL_OUTPUT_MAX ? `${text.slice(0, TOOL_OUTPUT_MAX)}\n[cut]` : text;
}

/** The prompt of a `user` record, or null when the record answers a tool. */
function promptOf(record: Record): { text: string; images: TranscriptTurn['images'] } | null {
  const content = record.message?.content;
  if (typeof content === 'string') return { text: content, images: [] };
  const blocks = blocksOf(content);
  if (blocks.some((block) => block['type'] === 'tool_result')) return null;
  const text = blocks
    .map((block) => (block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : ''))
    .filter((piece) => piece.length > 0)
    .join('\n');
  const images: TranscriptTurn['images'] = [];
  for (const block of blocks) {
    const source = block['source'];
    if (block['type'] !== 'image' || typeof source !== 'object' || source === null) continue;
    const { media_type: mimeType, data } = source as { media_type?: unknown; data?: unknown };
    if (typeof data !== 'string' || !(IMAGE_MIME_TYPES as readonly unknown[]).includes(mimeType)) continue;
    images.push({ mimeType: mimeType as ImageMimeType, data });
  }
  if (text.length === 0 && images.length === 0) return null;
  return { text, images };
}

/** Consumes records one at a time; `finish()` closes the tools no result reached. */
export class TranscriptReader {
  private readonly turns: TranscriptTurn[] = [];
  private agentTitle: string | null = null;
  private cwd: string | null = null;
  private model: string | null = null;
  private readonly tools = new Map<string, Extract<MessagePart, { type: 'tool' }>>();

  /** True once a prompt has been seen: what a listing stops at. */
  get hasPrompt(): boolean {
    return this.turns.length > 0;
  }

  /**
   * A listing needs the first prompt and the title records: once the prompt
   * is in hand, every other line is skipped on a substring test, no parse.
   */
  lineForListing(line: string): void {
    if (this.hasPrompt && !line.includes('"ai-title"') && !line.includes('"summary"')) return;
    this.line(line);
  }

  line(line: string): void {
    if (line.trim().length === 0) return;
    let record: Record;
    try {
      record = JSON.parse(line) as Record;
    } catch {
      return;
    }
    if (typeof record !== 'object' || record === null) return;
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.length > 0) {
      this.agentTitle = record.aiTitle;
      return;
    }
    if (record.type === 'summary' && typeof record.summary === 'string' && record.summary.length > 0) {
      this.agentTitle = record.summary;
      return;
    }
    if (record.isSidechain === true) return;
    if (record.type === 'user') this.user(record);
    else if (record.type === 'assistant') this.assistant(record);
  }

  private user(record: Record): void {
    const at = timeOf(record);
    const prompt = promptOf(record);
    if (prompt !== null) {
      if (this.cwd === null && typeof record.cwd === 'string') this.cwd = record.cwd;
      this.turns.push({ prompt: prompt.text, images: prompt.images, promptAt: at, parts: [], answerAt: null, lastAt: at });
      return;
    }
    const current = this.turns[this.turns.length - 1];
    for (const block of blocksOf(record.message?.content)) {
      if (block['type'] !== 'tool_result' || typeof block['tool_use_id'] !== 'string') continue;
      const tool = this.tools.get(block['tool_use_id']);
      if (tool === undefined) continue;
      tool.output = resultText(block['content']);
      tool.status = block['is_error'] === true ? 'error' : 'done';
      this.tools.delete(block['tool_use_id']);
      if (current !== undefined) current.lastAt = Math.max(current.lastAt, at);
    }
  }

  private assistant(record: Record): void {
    const current = this.turns[this.turns.length - 1];
    if (current === undefined) return;
    const at = timeOf(record);
    if (typeof record.message?.model === 'string') this.model = record.message.model;
    for (const block of blocksOf(record.message?.content)) {
      const last = current.parts[current.parts.length - 1];
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        if (block['text'].length === 0) continue;
        if (last !== undefined && last.type === 'text') last.text += block['text'];
        else current.parts.push({ type: 'text', text: block['text'] });
      } else if (block['type'] === 'thinking' && typeof block['thinking'] === 'string') {
        if (block['thinking'].trim().length === 0) continue;
        current.parts.push({ type: 'thinking', text: block['thinking'] });
      } else if (block['type'] === 'tool_use' && typeof block['id'] === 'string' && typeof block['name'] === 'string') {
        const tool: Extract<MessagePart, { type: 'tool' }> = {
          type: 'tool',
          toolId: block['id'],
          name: block['name'],
          input: block['input'] ?? null,
          output: null,
          status: 'running',
        };
        current.parts.push(tool);
        this.tools.set(block['id'], tool);
      } else {
        continue;
      }
      if (current.answerAt === null) current.answerAt = at;
      current.lastAt = Math.max(current.lastAt, at);
    }
  }

  finish(): Transcript {
    // A call the transcript never answered: the session stopped on it.
    for (const tool of this.tools.values()) {
      tool.status = 'error';
      tool.output = 'no result in the transcript';
    }
    this.tools.clear();
    return { turns: this.turns, agentTitle: this.agentTitle, cwd: this.cwd, model: this.model };
  }
}

/**
 * Reads the file line by line without holding it whole: a long session is
 * tens of megabytes. `listing` parses the first prompt and the title records
 * only, which is what a list of sessions needs.
 */
export async function readTranscript(file: string, listing = false): Promise<Transcript> {
  const reader = new TranscriptReader();
  const decoder = new TextDecoder();
  const take = listing ? (line: string) => reader.lineForListing(line) : (line: string) => reader.line(line);
  let rest = '';
  const chunks = Bun.file(file).stream().getReader();
  try {
    for (;;) {
      const { done, value } = await chunks.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
      let cut = rest.indexOf('\n');
      while (cut >= 0) {
        take(rest.slice(0, cut));
        rest = rest.slice(cut + 1);
        cut = rest.indexOf('\n');
      }
    }
    rest += decoder.decode();
    take(rest);
  } finally {
    await chunks.cancel().catch(() => undefined);
  }
  return reader.finish();
}
