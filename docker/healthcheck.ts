import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The address the running core wrote to `core.json`, so a `--port` or `--host`
 * given in `command:` is the one checked. 7337, the image's default, until the
 * core has written the file.
 */
function coreUrl(): string {
  let state: { port?: unknown; host?: unknown } = {};
  try {
    state = JSON.parse(readFileSync(join(process.env.BOITE_DATA_DIR || '/data', 'core.json'), 'utf8'));
  } catch {
    // No core has written it yet: the default port.
  }
  const port = typeof state.port === 'number' ? state.port : 7337;
  const bound = typeof state.host === 'string' ? state.host : '127.0.0.1';
  const host = bound === '0.0.0.0' || bound === '::' ? '127.0.0.1' : bound;
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

const response = await fetch(`${coreUrl()}/health`, {
  signal: AbortSignal.timeout(4000),
});
if (!response.ok) throw new Error(`core health returned ${response.status}`);
const health: unknown = await response.json();
if (health === null || typeof health !== 'object' || (health as { ok?: unknown }).ok !== true) {
  throw new Error('invalid core health response');
}
