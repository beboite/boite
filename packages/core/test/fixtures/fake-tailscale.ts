/**
 * A stand-in for the tailscale CLI: `status --json`, `serve status --json`,
 * `serve --bg --https=443 <target>` and `serve --https=443 off`, and for the
 * contacts' Funnel `funnel --bg --https=<port> --set-path=<path> <target>`
 * and `serve --https=<port> --set-path=<path> off`, read from and
 * written to a JSON state file. The file is the first argument when it ends in
 * `.json`, else `FAKE_TAILSCALE_STATE`. Each call is appended to
 * `<state>.log`. Never touches a real tailnet.
 *
 * State: { status: object | null, statusStderr?, serve: object, consent?,
 * denied?, serveHangs?, funnelConsent?, funnelError?, serveStatusFails? }.
 * `status: null` is a daemon that does not answer.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

interface State {
  status: { Self?: { DNSName?: string } } | null;
  statusStderr?: string;
  serve: { TCP?: Record<string, unknown>; Web?: Record<string, { Handlers?: Record<string, unknown> }>; AllowFunnel?: Record<string, boolean> };
  consent?: string;
  funnelConsent?: string;
  funnelError?: string;
  serveStatusFails?: boolean;
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
const name = (state.status?.Self?.DNSName ?? '').replace(/\.$/, '');
const flag = (key: string): string | undefined => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
if (args[0] === 'funnel') {
  const port = flag('https');
  const mount = flag('set-path');
  const target = args.at(-1);
  if (!(args.includes('--bg') && port && mount && target?.startsWith('http://'))) fail(`unexpected funnel arguments: ${command}`, 64);
  if (state.funnelConsent) {
    process.stdout.write(`Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n         ${state.funnelConsent}\n`);
    if (state.serveHangs) await new Promise(() => {});
    process.exit(1);
  }
  if (state.funnelError) fail(state.funnelError);
  const hostPort = `${name}:${port}`;
  state.serve.TCP = { ...(state.serve.TCP ?? {}), [port]: { HTTPS: true } };
  const web = state.serve.Web?.[hostPort] ?? {};
  state.serve.Web = { ...(state.serve.Web ?? {}), [hostPort]: { Handlers: { ...(web.Handlers ?? {}), [mount]: { Proxy: target } } } };
  state.serve.AllowFunnel = { ...(state.serve.AllowFunnel ?? {}), [hostPort]: true };
  save();
  process.stdout.write(`Available on the internet:\n\nhttps://${hostPort}${mount}\n|-- proxy ${target}\n`);
  process.exit(0);
}
if (args[0] === 'serve' && flag('set-path') !== undefined && args.at(-1) === 'off') {
  const port = flag('https')!;
  const hostPort = `${name}:${port}`;
  const handlers = state.serve.Web?.[hostPort]?.Handlers ?? {};
  if (!(flag('set-path')! in handlers)) fail('error: failed to remove web serve: handler does not exist');
  delete handlers[flag('set-path')!];
  if (Object.keys(handlers).length === 0) {
    delete state.serve.Web?.[hostPort];
    delete state.serve.TCP?.[port];
    delete state.serve.AllowFunnel?.[hostPort];
  }
  save();
  process.exit(0);
}
if (command === 'status --json') {
  if (state.status === null) fail(state.statusStderr ?? 'failed to connect to local tailscaled; it doesn\'t appear to be running');
  process.stdout.write(JSON.stringify(state.status));
} else if (command === 'serve status --json') {
  if (state.serveStatusFails) fail('failed to connect to local tailscaled; it doesn\'t appear to be running');
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
