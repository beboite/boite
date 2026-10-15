/*
 * What Claude Code sent with its last API request. Since 2.1.300 the CLI
 * writes three kinds of records into the session transcript beside the
 * conversation: `api-request-shape` holds the system blocks and tool
 * definitions under a `shapeHash`, written once per distinct shape;
 * `api-request` holds one request's parameters and names its shape by hash;
 * `api-request-blob` holds message bodies, which this reader never decodes.
 *
 * Transcripts reach hundreds of megabytes, so the file is read backwards in
 * fixed chunks: the last request is near the end, and its shape is the first
 * one with its hash found going back. A line is decoded only when its bytes
 * name one of the two record types, and a line longer than `LINE_MAX` is
 * dropped without being held whole.
 */

import { open, stat } from 'node:fs/promises';
import {
  AGENT_SHAPE_BLOCK_MAX, AGENT_SHAPE_ITEMS_MAX, AGENT_SHAPE_TEXT_BUDGET,
  type AgentShape, type AgentShapeBlock, type AgentShapeTool,
} from '@boite/contracts';

/** Bytes read per step from the end of the file. */
const CHUNK = 1 << 20;
/** A shape record is tens of kilobytes; a longer line is a message body and is skipped. */
export const LINE_MAX = 8 << 20;
/** Shapes met after the last request in file order, kept while it is looked for. */
const SHAPES_KEPT = 4;

const REQUEST = Buffer.from('"type":"api-request"');
const SHAPE = Buffer.from('"type":"api-request-shape"');

type Json = Record<string, unknown>;

function object(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : null;
}
const text = (value: unknown): string | null => typeof value === 'string' ? value : null;

/** The request and the shape it names, as the transcript holds them. */
export interface RequestShapeRecords {
  request: Json | null;
  shape: Json | null;
}

/**
 * Walks the file's lines from the last one back, handing each line whose bytes
 * contain a marker to `visit` until it returns true.
 */
async function backwards(file: string, visit: (line: Buffer) => boolean): Promise<void> {
  const handle = await open(file, 'r');
  try {
    let position = (await handle.stat()).size;
    // The bytes of the line whose start has not been reached yet, its tail end.
    let carry: Buffer = Buffer.alloc(0);
    let skipping = false;
    const consider = (line: Buffer): boolean => {
      if (line.length === 0 || line.length > LINE_MAX) return false;
      if (line.indexOf(REQUEST) < 0 && line.indexOf(SHAPE) < 0) return false;
      return visit(line);
    };
    while (position > 0) {
      const size = Math.min(CHUNK, position);
      position -= size;
      const chunk = Buffer.allocUnsafe(size);
      let read = 0;
      while (read < size) {
        const { bytesRead } = await handle.read(chunk, read, size - read, position + read);
        if (bytesRead === 0) throw new Error(`${file} shrank while it was read`);
        read += bytesRead;
      }
      const buffer = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      let end = buffer.length;
      while (end > 0) {
        const at = buffer.lastIndexOf(10, end - 1);
        if (at < 0) break;
        const line = buffer.subarray(at + 1, end);
        end = at;
        // The head of an oversized line, whose tail was already dropped.
        if (skipping) { skipping = false; continue; }
        if (consider(line)) return;
      }
      // An oversized line keeps no bytes: its head, reached later, is dropped too.
      if (end > LINE_MAX) { carry = Buffer.alloc(0); skipping = true; }
      else carry = Buffer.from(buffer.subarray(0, end));
    }
    if (!skipping) consider(carry);
  } finally {
    await handle.close();
  }
}

/** The last `api-request` record of a transcript and the `api-request-shape` it names. */
export async function readRequestShape(file: string): Promise<RequestShapeRecords> {
  let request: Json | null = null;
  let shape: Json | null = null;
  // Shapes written after the last request in file order: one may still be its own.
  const later: Json[] = [];
  await backwards(file, (line) => {
    let record: Json | null;
    try { record = object(JSON.parse(line.toString('utf8'))); } catch { return false; }
    if (record === null) return false;
    if (record['type'] === 'api-request' && request === null) {
      request = record;
      const hash = record['shapeHash'];
      shape = later.find((candidate) => candidate['shapeHash'] === hash) ?? null;
      return shape !== null;
    }
    if (record['type'] !== 'api-request-shape') return false;
    if (request === null) {
      if (later.length < SHAPES_KEPT) later.push(record);
      return false;
    }
    if (record['shapeHash'] !== request['shapeHash']) return false;
    shape = record;
    return true;
  });
  return { request, shape };
}

const quarter = (chars: number): number => Math.ceil(chars / 4);

/** The bounded answer for one transcript's records. */
export function summarizeShape(records: RequestShapeRecords): Omit<AgentShape, 'threadId' | 'sessionId'> {
  const params = object(records.request?.['params']) ?? {};
  const body = object(records.shape?.['shape']);
  const thinking = object(params['thinking']);
  const budget = thinking?.['budget_tokens'];
  const at = text(records.request?.['timestamp']);
  const parsedAt = at === null ? Number.NaN : Date.parse(at);
  const system: AgentShapeBlock[] = [];
  const omitted = { system: 0, tools: 0 };
  let systemChars = 0;
  let budgetLeft = AGENT_SHAPE_TEXT_BUDGET;
  for (const raw of Array.isArray(body?.['system']) ? body['system'] as unknown[] : []) {
    const block = object(raw);
    const whole = typeof raw === 'string' ? raw : text(block?.['text']) ?? '';
    systemChars += whole.length;
    if (system.length >= AGENT_SHAPE_ITEMS_MAX) { omitted.system += 1; continue; }
    const keep = Math.min(whole.length, AGENT_SHAPE_BLOCK_MAX, budgetLeft);
    budgetLeft -= keep;
    system.push({ chars: whole.length, text: whole.slice(0, keep), truncated: keep < whole.length });
  }
  const tools: AgentShapeTool[] = [];
  let toolChars = 0;
  for (const raw of Array.isArray(body?.['tools']) ? body['tools'] as unknown[] : []) {
    const tool = object(raw);
    if (tool === null) continue;
    const chars = JSON.stringify(tool).length;
    toolChars += chars;
    tools.push({ name: (text(tool['name']) ?? '?').slice(0, 200), descriptionChars: text(tool['description'])?.length ?? 0, chars });
  }
  tools.sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name));
  if (tools.length > AGENT_SHAPE_ITEMS_MAX) omitted.tools = tools.splice(AGENT_SHAPE_ITEMS_MAX).length;
  const betas = Array.isArray(params['betas']) ? (params['betas'] as unknown[]).filter((beta): beta is string => typeof beta === 'string').slice(0, 64) : [];
  const thinkingType = text(thinking?.['type']);
  return {
    status: body === null ? 'unrecorded' : 'ready',
    version: text(records.request?.['version']) ?? text(records.shape?.['version']),
    at: Number.isNaN(parsedAt) ? null : parsedAt,
    model: text(params['model']),
    effort: text(object(params['output_config'])?.['effort']),
    thinking: thinkingType === null ? null : typeof budget === 'number' ? `${thinkingType} ${budget}` : thinkingType,
    betas,
    maxTokens: typeof params['max_tokens'] === 'number' ? params['max_tokens'] : null,
    system,
    tools,
    omitted,
    chars: { system: systemChars, tools: toolChars },
    estimatedTokens: quarter(systemChars + toolChars),
  };
}

/** The last answer per file, reused while its size and modification time hold. */
const recent = new Map<string, { size: number; mtimeMs: number; shape: Omit<AgentShape, 'threadId' | 'sessionId'> }>();

/** The transcript's last request shape, or null when the file does not exist. */
export async function transcriptShape(file: string): Promise<Omit<AgentShape, 'threadId' | 'sessionId'> | null> {
  const found = await stat(file).catch(() => null);
  if (found === null || !found.isFile()) return null;
  const kept = recent.get(file);
  if (kept !== undefined && kept.size === found.size && kept.mtimeMs === found.mtimeMs) return kept.shape;
  const shape = summarizeShape(await readRequestShape(file));
  recent.delete(file);
  recent.set(file, { size: found.size, mtimeMs: found.mtimeMs, shape });
  if (recent.size > 16) recent.delete(recent.keys().next().value as string);
  return shape;
}
