/**
 * A stand-in for the tailscale CLI: `status --json`, `serve status --json`,
 * `serve --bg --https=443 <target>` and `serve --https=443 off`, read from and
 * written to a JSON state file. The file is the first argument when it ends in
 * `.json`, else `FAKE_TAILSCALE_STATE`. Each call is appended to
 * `<state>.log`. Never touches a real tailnet.
 *
 * State: { status: object | null, statusStderr?, serve: object, consent?,
 * denied?, serveHangs? }. `status: null` is a daemon that does not answer.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

interface State {
  status: { Self?: { DNSName?: string } } | null;
  statusStderr?: string;
  serve: { TCP?: Record<string, unknown>; Web?: Record<string, unknown> };
  consent?: string;
  denied?: boolean;
  serveHangs?: boolean;
}

let args = process.argv.slice(2);
let path = process.env['FAKE_TAILSCALE_STATE'] ?? '';
if (args[0]?.endsWith('.json')) {
  path = args[0];
  args = args.slice(1);
}
const state = JSON.parse(readFileSync(path, 'utf8')) as State;
appendFileSync(`${path}.log`, `${args.join(' ')}\n`);
const save = () => writeFileSync(path, JSON.stringify(state));
const host = `${(state.status?.Self?.DNSName ?? '').replace(/\.$/, '')}:443`;

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const command = args.join(' ');
if (command === 'status --json') {
  if (state.status === null) fail(state.statusStderr ?? 'failed to connect to local tailscaled; it doesn\'t appear to be running');
  process.stdout.write(JSON.stringify(state.status));
} else if (command === 'serve status --json') {
  process.stdout.write(JSON.stringify(state.serve));
} else if (args[0] === 'serve') {
  if (state.denied) fail('Access denied: serve config denied. Use \'sudo tailscale serve\' or set an operator with tailscale set --operator=$USER, auth key tskey-auth-SECRET');
  if (state.consent) {
    process.stdout.write(`Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         ${state.consent}\n`);
    if (state.serveHangs) await new Promise(() => {});
    process.exit(1);
  }
  if (command === 'serve --https=443 off') {
    delete state.serve.TCP?.['443'];
    delete state.serve.Web?.[host];
    save();
  } else if (args[1] === '--bg' && args[2] === '--https=443' && args[3]) {
    state.serve.TCP = { ...(state.serve.TCP ?? {}), '443': { HTTPS: true } };
    state.serve.Web = { ...(state.serve.Web ?? {}), [host]: { Handlers: { '/': { Proxy: args[3] } } } };
    save();
    process.stdout.write(`Available within your tailnet:\n\nhttps://${host.replace(':443', '')}/\n|-- proxy ${args[3]}\n\nServe started and running in the background.\n`);
  } else {
    fail(`unexpected serve arguments: ${command}`, 64);
  }
} else {
  fail(`unexpected arguments: ${command}`, 64);
}
