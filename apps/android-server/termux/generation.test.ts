import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreReadiness, FILES, judgeCoreHealth, planActivation, startTimeOf, type Layout } from './boite-server.ts';

const CONTROLLER = join(import.meta.dir, 'boite-server.ts');
const BUN = { version: '1.4.3', sha256: 'a'.repeat(64) };
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), 'boite-android-generation-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const core = { pid: 4242, started: '1', version: '2.0.0', host: '127.0.0.1', port: 7337, since: 0 };

test('a health answer counts only from the launched core: its PID and its version, nothing missing', () => {
  expect(judgeCoreHealth(core, { ok: true, pid: 4242, version: '2.0.0', bundleHash: 'x' })).toBeNull();
  expect(judgeCoreHealth(core, { ok: true, pid: 999, version: '2.0.0' })).toContain('process 999, not the core started as 4242');
  expect(judgeCoreHealth(core, { ok: true, pid: 4242, version: '1.9.0' })).toContain('"1.9.0", not 2.0.0');
  expect(judgeCoreHealth(core, { ok: true, pid: 4242 })).toContain('answers as undefined');
  expect(judgeCoreHealth(core, { ok: true, version: '2.0.0' })).toContain('process undefined');
  expect(judgeCoreHealth(core, { ok: true, pid: '4242', version: '2.0.0' })).toContain('process "4242"');
  for (const answer of [null, 'ok', [], { ok: 'yes', pid: 4242, version: '2.0.0' }]) expect(judgeCoreHealth(core, answer)).toBe('no core answers');
});

test('a core that exits while its answer is on the way is not ready', async () => {
  let running = true;
  const ask = async () => { running = false; return { ok: true, pid: 4242, version: '2.0.0' }; };
  expect(await coreReadiness(core, ask, () => running)).toBe('core 4242 exited while it answered');
  expect(await coreReadiness(core, async () => ({ ok: true, pid: 4242, version: '2.0.0' }), () => true)).toBeNull();
  expect(await coreReadiness(undefined, ask, () => true)).toBe('no core runs');
});

/** A release directory as a bundle unpacks: the core is a stand-in that answers `/health` as its release. */
function release(dir: string, version: string, controller = readFileSync(CONTROLLER)) {
  mkdirSync(join(dir, 'core'), { recursive: true });
  mkdirSync(join(dir, 'ui'), { recursive: true });
  writeFileSync(join(dir, 'server-release.json'), JSON.stringify({ version, bun: BUN }));
  writeFileSync(join(dir, 'ui', 'index.html'), version);
  writeFileSync(join(dir, 'boite-server.ts'), controller);
  writeFileSync(join(dir, 'core', 'main.js'), `
    const at = (flag) => process.argv[process.argv.indexOf(flag) + 1];
    Bun.serve({ hostname: at('--host'), port: Number(at('--port')), fetch: () => Response.json({ ok: true, pid: process.pid, version: ${JSON.stringify(version)} }) });
  `);
}

/** What selects the installed generation, as `rollback` must leave it. */
function selection(layout: Layout) {
  const link = (file: string) => existsSync(file) ? readlinkSync(file) : null;
  const releases = Bun.spawnSync(['find', layout.releases, '-type', 'f']).stdout.toString().split('\n').filter(Boolean).sort();
  return {
    current: link(layout.current), bun: link(join(layout.bin, 'bun')),
    controller: existsSync(layout.controller) ? readFileSync(layout.controller, 'utf8') : null,
    releases: releases.map((file) => [file, readFileSync(file, 'utf8')]),
  };
}

function installed(root: string, version: string) {
  const layout: Layout = { releases: join(root, 'releases'), current: join(root, 'current'), bin: join(root, 'bin'), controller: join(root, 'boite-server.ts') };
  const dir = join(layout.releases, version);
  release(dir, version, Buffer.from(`// controller of ${version}`));
  mkdirSync(layout.bin, { recursive: true });
  symlinkSync(join(root, 'runtime', 'bun-old', 'bun'), join(layout.bin, 'bun'));
  symlinkSync(dir, layout.current);
  writeFileSync(layout.controller, `// controller of ${version}`);
  return layout;
}

function prepared(layout: Layout, version: string, note: string) {
  const staging = join(layout.releases, `.staging-${process.pid}`);
  release(staging, version, Buffer.from(`// controller of ${version}, ${note}`));
  return { staging, release: { version, dir: staging, bun: BUN }, runtime: join(layout.releases, '..', 'runtime', 'bun-new', 'bun'), controller: Buffer.from(`// controller of ${version}, ${note}`) };
}

/** FILES with its `nth` change failing, until `disarm`; `changes` counts them. */
function failingAt(nth: number) {
  let count = 0;
  let armed = true;
  const fail = <A extends unknown[]>(change: (...args: A) => void) => (...args: A) => {
    count += 1;
    if (armed && count === nth) throw new Error(`injected failure of change ${nth}`);
    change(...args);
  };
  return {
    files: { rename: fail(FILES.rename), link: fail(FILES.link), unlink: FILES.unlink, write: fail(FILES.write) },
    changes: () => count,
    disarm: () => { armed = false; },
  };
}

test.skipIf(process.platform === 'win32').each([
  ['another version', '2.0.0'],
  ['the same version, reinstalled', '1.0.0'],
])('a failure at any activation step to %s puts the previous generation back exactly', (_name, version) => {
  for (let nth = 1; ; nth += 1) {
    const layout = installed(temporary(), '1.0.0');
    const next = prepared(layout, version, 'new');
    const before = selection(layout);
    const failing = failingAt(nth);
    const activation = planActivation(next, layout, failing.files);
    try {
      activation.apply();
    } catch (error) {
      expect(String(error)).toContain(`injected failure of change ${nth}`);
      activation.rollback();
      expect({ nth, ...selection(layout) }).toEqual({ nth, ...before });
      continue;
    }
    // Every change succeeded: the core never answering undoes all of them, the replaced copy included.
    const changes = failing.changes();
    // Four changes, and the replaced copy of a reinstalled version stepping aside first.
    expect(changes).toBe(version === '1.0.0' ? 5 : 4);
    failing.disarm();
    expect(readlinkSync(layout.current)).toBe(join(layout.releases, version));
    expect(readFileSync(layout.controller, 'utf8')).toBe(`// controller of ${version}, new`);
    activation.rollback();
    expect(selection(layout)).toEqual(before);
    break;
  }
});

test.skipIf(process.platform === 'win32')('a committed activation keeps only the new generation in place', () => {
  const layout = installed(temporary(), '1.0.0');
  const activation = planActivation(prepared(layout, '1.0.0', 'reinstalled'), layout);
  expect(activation.apply().version).toBe('1.0.0');
  activation.commit();
  expect(readFileSync(layout.controller, 'utf8')).toBe('// controller of 1.0.0, reinstalled');
  expect(Bun.spawnSync(['ls', layout.releases]).stdout.toString().trim()).toBe('1.0.0');
});

/** Runs the controller as Termux would, in its own home, against stand-in cores on a free local port. */
async function server(root: string) {
  const prefix = join(root, 'prefix');
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  mkdirSync(join(root, 'runtime', `bun-${BUN.version}`), { recursive: true });
  symlinkSync(process.execPath, join(root, 'runtime', `bun-${BUN.version}`, 'bun'));
  const free = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = free.port;
  free.stop(true);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ host: 'local', port, autostart: false }));
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(root, 'boite-server.ts'), ...args, '--json'], {
      cwd: root, env: { ...process.env, BOITE_SERVER_HOME: root, PREFIX: prefix, HOME: root }, stdout: 'pipe', stderr: 'pipe',
    });
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return JSON.parse(out.trim().split('\n').pop()!) as Record<string, unknown>;
  };
  const bundle = (version: string) => {
    const dir = join(root, `bundle-${version}`);
    release(dir, version);
    const zip = join(root, `bundle-${version}.zip`);
    expect(Bun.spawnSync(['zip', '-qr', zip, '.'], { cwd: dir }).exitCode).toBe(0);
    return zip;
  };
  // The first install puts this controller where the supervisor runs it from.
  writeFileSync(join(root, 'boite-server.ts'), readFileSync(CONTROLLER));
  cleanups.push(() => run('stop'));
  return { run, bundle, port };
}

test.skipIf(process.platform !== 'linux')('an update that fails after the core stopped starts the previous release again', async () => {
  const root = temporary();
  const { run, bundle } = await server(root);
  expect(await run('update', '--bundle', bundle('1.0.0'))).toMatchObject({ ok: true, version: '1.0.0' });
  expect(await run('start')).toMatchObject({ healthy: true, version: '1.0.0' });
  const controller = readFileSync(join(root, 'boite-server.ts'), 'utf8');
  const runtime = readlinkSync(join(root, 'bin', 'bun'));
  // The controller can no longer be replaced: the last step of the activation fails.
  mkdirSync(join(root, 'boite-server.ts.tmp', 'occupied'), { recursive: true });

  const failed = await run('update', '--bundle', bundle('2.0.0'));
  expect(failed).toMatchObject({ ok: false });
  expect(String(failed.error)).toContain('Boite 2.0.0 could not be installed; 1.0.0 runs again');
  expect(readlinkSync(join(root, 'current'))).toBe(join(root, 'releases', '1.0.0'));
  expect(readlinkSync(join(root, 'bin', 'bun'))).toBe(runtime);
  expect(readFileSync(join(root, 'boite-server.ts'), 'utf8')).toBe(controller);
  expect(await run('status', '--quick')).toMatchObject({ running: true, healthy: true, version: '1.0.0' });
}, 60_000);

test.skipIf(process.platform !== 'linux')('another Boite answering on the core\'s port does not make it healthy', async () => {
  const root = temporary();
  const { run, port } = await server(root);
  let answer: Record<string, unknown> = { ok: true, pid: 999_999, version: '1.0.0' };
  const other = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => Response.json(answer) });
  cleanups.push(() => other.stop(true));
  // This test process stands in for the core the supervisor recorded.
  const started = startTimeOf(readFileSync('/proc/self/stat', 'utf8'));
  writeFileSync(join(root, 'server.json'), JSON.stringify({ core: { pid: process.pid, started, version: '1.0.0', host: '127.0.0.1', port, since: 0 } }));
  // Gone before the cleanup's `stop`, which would otherwise signal this process.
  cleanups.push(() => rmSync(join(root, 'server.json'), { force: true }));
  expect(await run('status', '--quick')).toMatchObject({ running: true, healthy: false });
  answer = { ok: true, pid: process.pid, version: '0.9.0' };
  expect(await run('status', '--quick')).toMatchObject({ running: true, healthy: false });
  answer = { ok: true, pid: process.pid, version: '1.0.0' };
  expect(await run('status', '--quick')).toMatchObject({ running: true, healthy: true });
});
