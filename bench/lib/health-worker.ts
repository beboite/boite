import { writeFileSync } from 'node:fs';

// Keep the HTTP observer off the event loop parsing the load test's WebSocket frames.
const [url, output] = process.argv.slice(2);
if (!url || !output) throw new Error('expected a core URL and a result path');
let stopped = false;
const input = Bun.stdin.stream().getReader();
void input.read().then(() => { stopped = true; });
const samples: number[] = [];
const errors: string[] = [];
while (!stopped) {
  const start = performance.now();
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`health returned ${response.status}`);
    samples.push(performance.now() - start);
  } catch (error) {
    errors.push(`${(performance.now() - start).toFixed(0)} ms: ${error instanceof Error ? error.message : String(error)}`);
  }
  writeFileSync(output, JSON.stringify({ samples, errors }));
  if (samples.length + errors.length === 1) console.log('ready');
  await Bun.sleep(100);
}
await input.cancel();
