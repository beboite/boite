import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.BOITE_SMOKE_URL ?? 'http://127.0.0.1:7337';
const data = process.env.BOITE_DATA_DIR ?? '/data';
const workspace = process.env.BOITE_SMOKE_WORKSPACE ?? '/workspace/smoke';
const html = await (await fetch(base)).text();
assert(html.includes('<script'), 'built UI must be served');
assert(!html.includes('UI is not built'), 'placeholder UI is not a release');
const asset = html.match(/src="([^\"]+\.js)"/)?.[1];
assert(asset, 'UI entry asset missing');
assert.equal((await fetch(new URL(asset, base))).status, 200);

const state = JSON.parse(readFileSync(join(data, 'core.json'), 'utf8'));
const ws = new WebSocket(`${base.replace('http', 'ws')}/rpc`);
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = () => reject(new Error('websocket failed'));
});
let id = 0;
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
ws.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
};
async function call(method: string, params: object): Promise<any> {
  const next = ++id;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(next); reject(new Error(`${method} timed out`)); }, 15000);
    pending.set(next, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }));
  });
}
try {
  const hello = await call('hello', { protocolVersion: 2, token: state.token, client: { name: 'docker-smoke', version: '1' } });
  assert(hello, 'authenticated hello failed');
  assert.equal(hello.core.channel, process.env.BOITE_SMOKE_CHANNEL ?? 'stable', 'server channel mismatch');
  if (process.env.BOITE_SMOKE_VERSION) assert.equal(hello.core.version, process.env.BOITE_SMOKE_VERSION, 'server version mismatch');
  if (process.argv[2] === 'create') {
    mkdirSync(workspace, { recursive: true });
    const project = await call('projects.add', { name: 'smoke', path: workspace });
    const providers = await call('providers.list', {});
    for (const id of (process.env.BOITE_SMOKE_PROVIDERS ?? 'claude,codex,opencode,pi,echo').split(',')) {
      assert(providers.loaded.some((provider: any) => provider.id === id && provider.available), `${id} executable unavailable`);
    }
    const account = await call('accounts.add', { providerId: 'echo', label: 'smoke' });
    const thread = await call('threads.create', { projectId: project.id, accountId: account.id, providerId: 'echo', model: 'echo' });
    await call('turns.start', { threadId: thread.id, prompt: 'container persistence check' });
    let finished = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await call('threads.get', { threadId: thread.id });
      if (result.turns.some((turn: any) => turn.status === 'done')) { finished = true; break; }
      await Bun.sleep(100);
    }
    assert(finished, 'echo turn did not finish');
    writeFileSync(join(data, 'smoke-thread'), thread.id);
  } else {
    const threadId = readFileSync(join(data, 'smoke-thread'), 'utf8');
    const result = await call('threads.get', { threadId });
    assert(result.turns.some((turn: any) => turn.status === 'done'), 'finished turn lost on restart');
    assert(JSON.stringify(result.messages).includes('container persistence check'), 'message lost on restart');
  }
} finally {
  ws.close();
}
