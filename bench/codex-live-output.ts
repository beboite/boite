/**
 * What the live output of one running Codex command costs: the running tool
 * parts the driver publishes, the output characters they carry (each one is a
 * journal write and a `message.part` frame to every client), and the CPU spent
 * taking the deltas in. The command prints a 100-character line every 5 ms
 * for 6 s (1,200 deltas). No agent or core runs: the driver's turn gets a
 * counting emit sink.
 *
 * Run: bun bench/codex-live-output.ts
 */
import type { TurnContext } from '../packages/core/src/drivers/types.ts';
import { CodexTurn } from '../packages/core/src/drivers/codex/turn.ts';

let parts = 0;
let chars = 0;
const ctx = {
  sessionId: null,
  emit: {
    startMessage: () => 'm',
    part: (_message: string, _index: number, part: { type: string; status?: string; output?: string | null }) => {
      if (part.type !== 'tool' || part.status !== 'running') return;
      parts += 1;
      chars += (part.output ?? '').length;
    },
    delta: () => undefined,
    complete: () => undefined,
  },
  log: () => undefined,
} as unknown as TurnContext;

const turn = new CodexTurn(ctx);
turn.upsertTool('cmd', { name: 'Bash', input: { command: 'cargo build' }, output: null, status: 'running' });
parts = 0;
chars = 0;
const line = `${'x'.repeat(99)}\n`;
let cpu = 0;
for (let index = 0; index < 1_200; index++) {
  const start = performance.now();
  turn.appendOutput('cmd', line);
  cpu += performance.now() - start;
  await Bun.sleep(5);
}
await Bun.sleep(1_100);
console.log(`running parts ${parts}, output chars ${chars}, appendOutput CPU ${cpu.toFixed(2)} ms`);
