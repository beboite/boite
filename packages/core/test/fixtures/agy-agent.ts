/**
 * A fake Antigravity CLI in its headless mode,
 * `agy --input-format stream-json --output-format stream-json -p=`: one JSON
 * prompt per line on stdin, one JSON event per line on stdout (`init` once,
 * `step_update` per step, `result` per turn), shaped like agy 1.2.2's. It also
 * answers `agy models` with the tab-separated listing the real one prints.
 *
 * Run as `bun <this file> <agy arguments>`. `AGY_FAKE_LOG` names a file it
 * appends to: one `argv conversation=<id> model=<m> mode=<m> skip=<bool> stream=<bool>`
 * line per conversation process, one `env BROWSER=<value>` line with it, one
 * `prompt <text>` line per prompt, and `models` for each listing.
 * `AGY_FAKE_SIGNED_OUT=1` makes it answer like an agy nobody signed in to.
 *
 * Prompt directives: `[tool]` runs one tool between two answers, `[toolerror]`
 * runs one that fails, `[error]` ends the turn with an ERROR result, `[silent]`
 * streams nothing and answers in the result alone, `[slow]` never finishes,
 * `[crash]` prints `boom` on stderr and exits with code 3. Anything else is
 * echoed back in three chunks.
 */
import { appendFileSync } from 'node:fs';

function log(line: string): void {
  const file = process.env['AGY_FAKE_LOG'];
  if (file === undefined || file.length === 0) return;
  appendFileSync(file, `${line}\n`, 'utf8');
}

function send(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const args = process.argv.slice(2);

function flag(name: string): string {
  const at = args.indexOf(name);
  return at < 0 ? '' : (args[at + 1] ?? '');
}

// ---------------------------------------------------------------------------
// agy models
// ---------------------------------------------------------------------------

if (args[0] === 'models') {
  log('models');
  process.stdout.write('Fetching available models...\n');
  if (process.env['AGY_FAKE_SIGNED_OUT'] === '1') {
    process.stdout.write('Please sign in to Antigravity before listing models.\n');
    process.exit(1);
  }
  const listing = [
    ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
    ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'],
    ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
    ['gemini-3.1-pro-low', 'Gemini 3.1 Pro (Low)'],
    ['gemini-3.1-pro-high', 'Gemini 3.1 Pro (High)'],
    ['claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)'],
    ['gemini-solo-high', 'Gemini Solo (High)'],
  ];
  for (const [id, label] of listing) process.stdout.write(`${id}\t${label}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The conversation process
// ---------------------------------------------------------------------------

// The real CLI needs `-p=` for print mode; a bare `-p` would take the next flag.
if (args.at(-1) !== '-p=') {
  process.stderr.write('print mode was not asked for with -p=\n');
  process.exit(2);
}

const conversationId = flag('--conversation') || `conv-${crypto.randomUUID()}`;
const model = flag('--model') || 'configured';
const mode = flag('--mode') || 'default';
const skip = args.includes('--dangerously-skip-permissions');
const stream = flag('--input-format') === 'stream-json' && flag('--output-format') === 'stream-json';
log(`argv conversation=${flag('--conversation') || 'new'} model=${model} mode=${mode} skip=${skip} stream=${stream}`);
log(`env BROWSER=${process.env['BROWSER'] ?? ''}`);

let stepIndex = 0;
const total = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 };

send({
  event: 'init',
  conversation_id: conversationId,
  init: { model, cwd: process.cwd(), tools: ['run_command', 'view_file'], permission_mode: mode },
});

function step(fields: Record<string, unknown>): void {
  send({ event: 'step_update', step_update: { conversation_id: conversationId, ...fields } });
}

function answer(text: string, usage: { input_tokens: number; output_tokens: number; thinking_tokens: number; cache_read_tokens: number }): void {
  const index = stepIndex++;
  step({ step_index: index, state: 'ACTIVE', step_type: 'agent_response' });
  const size = Math.max(1, Math.ceil(text.length / 3));
  for (let at = 0; at < text.length; at += size) {
    step({ step_index: index, state: 'ACTIVE', step_type: 'agent_response', text_delta: text.slice(at, at + size) });
  }
  const full = { ...usage, total_tokens: usage.input_tokens + usage.output_tokens + usage.thinking_tokens + usage.cache_read_tokens };
  step({ step_index: index, state: 'DONE', step_type: 'agent_response', usage: full });
  total.input_tokens += usage.input_tokens;
  total.output_tokens += usage.output_tokens;
  total.thinking_tokens += usage.thinking_tokens;
  total.cache_read_tokens += usage.cache_read_tokens;
  total.total_tokens += full.total_tokens;
}

function tool(fails: boolean): void {
  const index = stepIndex++;
  const info = { name: 'run_command', parameters: { CommandLine: 'echo hi' } };
  step({ step_index: index, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: info });
  if (fails) {
    step({
      step_index: index,
      state: 'ERROR',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { ...info, error: { type: 'PERMISSION_DENIED', message: 'the command was denied' } },
    });
  } else {
    step({ step_index: index, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: info });
  }
}

function result(status: 'SUCCESS' | 'ERROR', response: string, error?: unknown): void {
  send({
    event: 'result',
    result: {
      conversation_id: conversationId,
      status,
      response,
      ...(error === undefined ? {} : { error }),
      duration_seconds: 0.1,
      num_turns: 1,
      usage: { ...total },
    },
  });
}

const FIRST = { input_tokens: 10, output_tokens: 4, thinking_tokens: 2, cache_read_tokens: 6 };
const SECOND = { input_tokens: 3, output_tokens: 5, thinking_tokens: 1, cache_read_tokens: 20 };

function turn(text: string): void {
  const input = stepIndex++;
  step({ step_index: input, state: 'DONE', step_type: 'user_input' });
  if (text.includes('[crash]')) {
    process.stderr.write('boom\n');
    process.exit(3);
  }
  if (text.includes('[slow]')) {
    step({ step_index: stepIndex++, state: 'ACTIVE', step_type: 'agent_response' });
    return;
  }
  if (text.includes('[error]')) {
    result('ERROR', '', { message: 'the quota is exhausted' });
    return;
  }
  if (text.includes('[silent]')) {
    result('SUCCESS', 'from the result');
    return;
  }
  if (text.includes('[tool]') || text.includes('[toolerror]')) {
    answer('checking', FIRST);
    tool(text.includes('[toolerror]'));
    answer('checked', SECOND);
    result('SUCCESS', 'checked');
    return;
  }
  answer(text, FIRST);
  result('SUCCESS', text);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const at = buffer.indexOf('\n');
    if (at < 0) break;
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line.length === 0) continue;
    const message = JSON.parse(line) as { event?: string; message?: { content?: unknown } };
    if (message.event !== 'user') {
      result('ERROR', '', 'a stream-json input line needs an event');
      continue;
    }
    const content = message.message?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((block: { text?: string }) => block.text ?? '').join('')
        : '';
    log(`prompt ${text}`);
    turn(text);
  }
});
process.stdin.on('end', () => {
  log('stdin closed');
  process.exit(0);
});
