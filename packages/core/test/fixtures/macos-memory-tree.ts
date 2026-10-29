/** A controlled agent -> worker -> leaf tree for the native libproc regression. */
const role = process.argv[2] ?? 'root';
const child = role === 'leaf' ? null : Bun.spawn([
  process.execPath, import.meta.filename, role === 'root' ? 'worker' : 'leaf',
], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit', windowsHide: true });

// Touch and retain private pages so each process has a measurable footprint.
const memory = Buffer.alloc(8 * 1024 ** 2, 1);
const keepAlive = setInterval(() => { memory[0] = memory[0]! ^ 1; }, 1000);
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (child !== null) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await child.exited;
  }
  clearInterval(keepAlive);
  process.exit(0);
}
process.once('SIGTERM', () => { void stop(); });
setTimeout(() => { void stop(); }, 15_000).unref();

let descendants: Record<string, number> = {};
if (child !== null) {
  const reader = child.stdout.getReader();
  let text = '';
  const decoder = new TextDecoder();
  while (!text.includes('\n')) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`${role}: child exited before reporting its PID`);
    text += decoder.decode(chunk.value, { stream: true });
  }
  descendants = JSON.parse(text.split('\n')[0]!);
  reader.releaseLock();
  void child.exited.then(() => { console.log(JSON.stringify({ exited: child.pid, signal: child.signalCode })); });
}
console.log(JSON.stringify({ [role]: process.pid, ...descendants }));
