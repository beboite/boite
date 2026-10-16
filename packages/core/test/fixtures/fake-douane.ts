/**
 * A stand-in for Douane: `--config <file>`, the `listen` line of that file,
 * `/health`, `/v1/models` and `/admin/api/summary`. Environment:
 * FAKE_DOUANE_VERSION names its version; FAKE_DOUANE_CRASH_FILE, when that
 * file exists, makes it delete the file and exit with code 3 a moment after
 * it answers; FAKE_DOUANE_IN_FLIGHT_FILE holds the number `in_flight` reports.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';

const at = process.argv.indexOf('--config');
const config = at > 0 ? process.argv[at + 1] : undefined;
if (!config) {
  console.error('ERROR fake douane: --config is required');
  process.exit(2);
}
const listen = /^listen\s*=\s*"([^"]+)"/m.exec(readFileSync(config, 'utf8'))?.[1];
const [hostname, port] = (listen ?? '').split(':');
if (!hostname || !port) {
  console.error(`ERROR fake douane: no listen line in ${config}`);
  process.exit(2);
}
const version = process.env.FAKE_DOUANE_VERSION ?? '0.3.0';

Bun.serve({
  hostname, port: Number(port),
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/health') return Response.json({ status: 'ok', version, service: 'douane' });
    if (path === '/v1/models') return Response.json({ object: 'list', data: [{ id: 'claude-sonnet-5', object: 'model', supported_endpoint_types: ['anthropic'] }] });
    // What the core left in its environment: a gateway gets no owner token and no agent variable.
    if (path === '/debug/env') return Response.json({ token: process.env.BOITE_TOKEN !== undefined, thread: process.env.BOITE_THREAD_ID !== undefined, cwd: process.cwd() });
    if (path === '/admin/api/summary') {
      const file = process.env.FAKE_DOUANE_IN_FLIGHT_FILE;
      const inFlight = file && existsSync(file) ? Number(readFileSync(file, 'utf8').trim()) || 0 : 0;
      return Response.json({ in_flight: inFlight, version });
    }
    return new Response('not found', { status: 404 });
  },
});
console.log(`INFO fake douane ${version} listening on ${listen}`);

const crash = process.env.FAKE_DOUANE_CRASH_FILE;
if (crash && existsSync(crash)) {
  rmSync(crash, { force: true });
  setTimeout(() => {
    console.error('ERROR fake douane: crashing on purpose');
    process.exit(3);
  }, 300);
}
