// The test UI server as a process of its own, started by `ui.ts`:
// `node ui-server.ts dev <port>` or `node ui-server.ts preview <port> <outDir>`.
// It prints `ready <modules>` once it serves, and closes when its stdin ends,
// so it also goes when the test process dies.
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureBridge, transformAll, uiRoot } from './ui-fixture.ts';

const [mode, portText, outDir] = process.argv.slice(2);
const port = Number(portText);
if ((mode !== 'dev' && mode !== 'preview') || !Number.isInteger(port) || port <= 0 || (mode === 'preview' && !outDir)) {
  console.error(`usage: ui-server.ts dev <port> | preview <port> <outDir>; got ${JSON.stringify(process.argv.slice(2))}`);
  process.exit(2);
}

const vite = await import(pathToFileURL(createRequire(join(uiRoot, 'package.json')).resolve('vite')).href);
const address = { host: '127.0.0.1', port, strictPort: true };
let close: () => Promise<void>;
let modules = 0;
if (mode === 'dev') {
  const server = await vite.createServer({ root: uiRoot, plugins: [fixtureBridge], server: address, clearScreen: false });
  close = () => server.close();
  await server.listen();
  modules = await transformAll(server, '/src/main.ts');
} else {
  const server = await vite.preview({ root: uiRoot, build: { outDir: resolve(outDir ?? '') }, preview: address, clearScreen: false });
  close = () => server.close();
}

let closing = false;
const stop = (): void => {
  if (closing) return;
  closing = true;
  // Vite can keep handles after close; this process exists only to serve.
  void close().finally(() => process.exit(0));
};
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.resume();
console.log(`ready ${modules}`);
