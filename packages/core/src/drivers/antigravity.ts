/**
 * Antigravity's dialect of ACP, ported from T3 Code's `AntigravityProtocol.ts`
 * and cut to what the Boite contract can draw. Two things need fixing and no
 * more:
 *
 * - A tool call's payload. The agent spells a shell call's command, its working
 *   directory and its combined output half a dozen ways, and pads `_meta` and
 *   `rawOutput` with base64 images and outputs it already sent as text. What is
 *   kept is bounded and normalised, so the tool card shows the command instead
 *   of a wall of JSON, and nothing megabyte-sized is journalled.
 * - A question. The agent asks the user to choose through the permission
 *   method, under a `interaction_` tool call id and with its own choices rather
 *   than the protocol's allow and reject kinds. The contract has no part for a
 *   free-form question, so the driver draws the permission card it arrived as
 *   and picks the agent's first choice on allow.
 */
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';

/** A tool's text is bounded at this, the tail kept: the end of a log is the part that matters. */
const TEXT_LIMIT = 8_000;
const TEXT_TRUNCATED = '[earlier output truncated]\n\n';
/** How much of a payload survives sanitising, in nodes and in characters. */
const NODE_BUDGET = 512;
const CHAR_BUDGET = 64_000;
const MAX_DEPTH = 12;

/** The prefix Antigravity puts on a tool call id that is really a question. */
const QUESTION_PREFIX = 'interaction_';

interface Budget {
  nodes: number;
  chars: number;
}

function bound(text: string, limit = TEXT_LIMIT): string {
  return text.length <= limit ? text : `${TEXT_TRUNCATED}${text.slice(-limit)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A payload with its images dropped, its strings bounded and its size capped.
 * `undefined` means the value did not survive the budget, so the caller leaves
 * the key out rather than writing a hole.
 */
function sanitize(value: unknown, budget: Budget, depth: number): unknown {
  if (depth > MAX_DEPTH || budget.nodes-- <= 0) return undefined;
  if (typeof value === 'string') {
    if (/^data:image\//i.test(value) || budget.chars <= 0) return undefined;
    const text = bound(value, Math.min(TEXT_LIMIT, budget.chars));
    budget.chars -= text.length;
    return text;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value) {
      if (budget.nodes <= 0) break;
      const kept = sanitize(entry, budget, depth + 1);
      if (kept !== undefined) out.push(kept);
    }
    return out;
  }
  if (!isPlainObject(value)) return value;
  const entries: [string, unknown][] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (budget.nodes <= 0) break;
    // The raw image bytes of an image block, and the pretty copy of an output
    // the payload already carries under its own key.
    const image =
      (value['type'] === 'image' && (key === 'data' || key === 'blob')) ||
      (key === 'blob' && typeof value['mimeType'] === 'string' && value['mimeType'].startsWith('image/'));
    const duplicate =
      (key === 'formatted_output' || key === 'formattedOutput') &&
      (entry === value['combinedOutput'] || entry === value['combined_output']);
    if (image || duplicate) continue;
    const kept = sanitize(entry, budget, depth + 1);
    if (kept !== undefined) entries.push([key, kept]);
  }
  return Object.fromEntries(entries);
}

export function sanitizeAntigravityPayload(payload: unknown): unknown {
  return sanitize(payload, { nodes: NODE_BUDGET, chars: CHAR_BUDGET }, 0);
}

function firstString(source: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (source === null) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) return bound(value.trim());
  }
  return undefined;
}

function firstInteger(source: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (source === null) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return undefined;
}

const COMMAND_KEYS = ['CommandLine', 'command_line', 'commandLine', 'command'];
const CWD_KEYS = ['Cwd', 'WorkingDirectory', 'working_dir', 'workingDir', 'cwd'];
const OUTPUT_KEYS = ['combinedOutput', 'combined_output'];
const EXIT_KEYS = ['exitCode', 'exit_code'];

/**
 * A tool call's input and output as the card should show them. `input` gains
 * `command` and `cwd` under one spelling whichever one the agent used; `output`
 * becomes the combined output the agent already produced, with its exit code,
 * rather than the whole payload restringified. A key that is absent stays
 * absent, so an update that carries only a status changes nothing.
 */
export function normalizeAntigravityTool(
  rawInput: unknown,
  rawOutput: unknown,
): { input?: unknown; output?: string } | null {
  const input = isPlainObject(rawInput) ? rawInput : null;
  const output = isPlainObject(rawOutput) ? rawOutput : null;
  const result: { input?: unknown; output?: string } = {};

  if (rawInput !== undefined) {
    const clean = sanitizeAntigravityPayload(rawInput);
    const command = firstString(input, COMMAND_KEYS) ?? firstString(output, COMMAND_KEYS);
    const cwd = firstString(input, CWD_KEYS) ?? firstString(output, CWD_KEYS);
    result.input =
      isPlainObject(clean) && (command !== undefined || cwd !== undefined)
        ? { ...clean, ...(command === undefined ? {} : { command }), ...(cwd === undefined ? {} : { cwd }) }
        : clean;
  }

  if (rawOutput !== undefined && rawOutput !== null) {
    const combined = firstString(output, OUTPUT_KEYS);
    const exitCode = firstInteger(output, EXIT_KEYS);
    if (combined !== undefined) {
      result.output = exitCode === undefined ? combined : `${combined}\n[exit ${exitCode}]`;
    } else if (typeof rawOutput === 'string') {
      result.output = bound(rawOutput);
    } else {
      const clean = sanitizeAntigravityPayload(rawOutput);
      result.output = clean === undefined ? '' : (JSON.stringify(clean) ?? '');
    }
  }

  return Object.keys(result).length === 0 ? null : result;
}

/**
 * True when this permission request is really a question the agent is asking.
 * The id is the discriminator Antigravity uses; a request with no options at
 * all is never one, because there would be nothing to answer with.
 */
export function isAntigravityQuestion(request: RequestPermissionRequest): boolean {
  return request.toolCall.toolCallId.startsWith(QUESTION_PREFIX) && request.options.length > 0;
}
