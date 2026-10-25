import { expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPayload } from '../../../packages/core/src/server-update/release.ts';
import {
  bindAddress, bundleName, checkEntries, coreEnv, DEFAULT_CONFIG, deviceName, GLIBC_INTERPRETER, loaderLink, newestRelease, offerOf, pairingLinks, parseConfig, patchInterpreter, pickRelease,
  reachableAt, rotateLog, signIns, startTimeOf, tailscaleAddress, TARGET, UPDATE_PUBLIC_KEY, verifyFile, withSetting, type Interfaces,
} from './boite-server.ts';

const temporary = () => mkdtempSync(join(tmpdir(), 'boite-android-server-'));

test('the controller trusts the key the desktop updater trusts', () => {
  const config = JSON.parse(readFileSync(join(import.meta.dir, '../../shell/src-tauri/tauri.conf.json'), 'utf8')) as { plugins: { updater: { pubkey: string } } };
  expect(UPDATE_PUBLIC_KEY).toBe(config.plugins.updater.pubkey);
});

test('a bundle installs only with a signature the core would accept for the same bytes', () => {
  const keys = generateKeyPairSync('ed25519');
  const keyId = randomBytes(8);
  const rawKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const publicKey = Buffer.from(`untrusted comment: test key\n${Buffer.concat([Buffer.from('Ed'), keyId, rawKey]).toString('base64')}\n`).toString('base64');
  const signs = (bytes: Uint8Array, algorithm: 'Ed' | 'ED', comment = 'version:2.0.0') => {
    const signature = sign(null, algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes, keys.privateKey);
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), keys.privateKey).toString('base64');
    const packet = Buffer.concat([Buffer.from(algorithm), keyId, signature]).toString('base64');
    return Buffer.from(`untrusted comment: test\n${packet}\ntrusted comment: ${comment}\n${global}\n`).toString('base64');
  };
  const dir = temporary();
  try {
    const file = join(dir, bundleName('2.0.0'));
    const bytes = Buffer.from('a signed Android bundle');
    writeFileSync(file, bytes);
    for (const algorithm of ['Ed', 'ED'] as const) {
      const signature = signs(bytes, algorithm);
      expect(() => verifyPayload(bytes, signature, publicKey)).not.toThrow();
      expect(() => verifyFile(file, signature, publicKey)).not.toThrow();
      expect(() => verifyFile(file, signs(Buffer.from('other bytes'), algorithm), publicKey)).toThrow('does not match');
      const comment = Buffer.from(signature, 'base64').toString().replace('version:2.0.0', 'version:9.0.0');
      expect(() => verifyFile(file, Buffer.from(comment).toString('base64'), publicKey)).toThrow('does not match');
      // The release key never signed this test payload.
      expect(() => verifyFile(file, signature)).toThrow('release key');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an update comes from the channel\'s newest release that carries the Android bundle, from this repository', async () => {
  const release = (version: string, assets = [bundleName(version)], draft = false) => ({ tag_name: `v${version}`, draft, assets: assets.map((name) => ({ name })) });
  const releases = [
    release('2.0.0-nightly.20261025.1'),
    release('2.0.1', ['boite-server_2.0.1_x64.zip']),
    release('2.0.0-nightly.20261101.2'),
    release('2.2.0', undefined, true),
    release('2.0.0'),
    release('2.0.0-nightly.20261101.1'),
  ];
  expect(pickRelease(releases, 'stable')).toBe('2.0.0');
  expect(pickRelease(releases, 'nightly')).toBe('2.0.0-nightly.20261101.2');
  expect(pickRelease([release('2.0.0-nightly.20261025.1')], 'stable')).toBeNull();

  // A hundred nightlies push the stable release onto the second page; a short page is the last one.
  const pages = [Array.from({ length: 100 }, (_, i) => release(`2.0.0-nightly.20261101.${i + 1}`)), [release('2.0.0-beta.1')]];
  const read: number[] = [];
  const page = async (n: number) => { read.push(n); return pages[n - 1] ?? []; };
  expect(await newestRelease('stable', page)).toBe('2.0.0-beta.1');
  expect(await newestRelease('nightly', page)).toBe('2.0.0-nightly.20261101.100');
  expect(read).toEqual([1, 2, 1]);
  expect(await newestRelease('stable', async () => [release('2.0.0-nightly.20261025.1')])).toBeNull();

  const manifest = (url: string, version = '2.0.0') => ({ version, platforms: { [TARGET]: { url, signature: 'c2ln' } } });
  for (const owner of ['mtsu-dev', 'beboite']) {
    const url = `https://github.com/${owner}/boite/releases/download/v2.0.0/${bundleName('2.0.0')}`;
    expect(offerOf(manifest(url), '2.0.0')).toEqual({ version: '2.0.0', url, signature: 'c2ln' });
  }
  expect(() => offerOf(manifest(`https://github.com/someone/boite/releases/download/v2.0.0/${bundleName('2.0.0')}`), '2.0.0')).toThrow(TARGET);
  expect(() => offerOf(manifest(`https://github.com/beboite/boite/releases/download/v1.9.0/${bundleName('1.9.0')}`), '2.0.0')).toThrow(TARGET);
  expect(() => offerOf(manifest('', '2.0.1'), '2.0.0')).toThrow('names version "2.0.1"');
});

test('a rotated log keeps receiving what the running supervisor writes', () => {
  const dir = temporary();
  try {
    const log = join(dir, 'core.log');
    // The descriptor `start` hands the supervisor, and the core after it.
    const inherited = openSync(log, 'a');
    writeSync(inherited, 'before\n'.repeat(4));
    rotateLog(log, 10);
    writeSync(inherited, 'after\n');
    closeSync(inherited);
    expect(readFileSync(log, 'utf8')).toBe('after\n');
    expect(readFileSync(`${log}.1`, 'utf8')).toBe('before\n'.repeat(4));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent counts as signed in when one of its accounts is, and as signed out with none', () => {
  const account = (providerId: string, status: string) => ({ id: `${providerId}-${status}`, providerId, label: 'Default', status, isolationDir: null, identity: null, createdAt: 0 });
  // The owner's own account beside a default one the CLI signed out of; Codex never signed in, so the core holds no account of it.
  expect(signIns([account('claude', 'unauthenticated'), account('claude', 'ok'), account('pi', 'unknown'), account('pi', 'error')]))
    .toEqual({ claude: 'ok', pi: 'unknown' });
  expect(signIns([account('claude', 'unauthenticated'), { providerId: 'codex', status: 'signed-in' }, null])).toEqual({ claude: 'unauthenticated' });
  expect(signIns([])).toEqual({});
  expect(() => signIns({ error: 'no core' })).toThrow('no list');
});

test('an archive entry that would land outside its release directory stops the update', () => {
  expect(() => checkEntries(['core/main.js', 'ui/assets/index.js', 'server-release.json'])).not.toThrow();
  for (const name of ['../boite-server.ts', 'core/../../bin/bun', '/data/data/com.termux/files/usr/bin/sh', 'ui\\..\\x']) {
    expect(() => checkEntries(['core/main.js', name])).toThrow(name);
  }
});

/** An aarch64 ELF header, a PT_LOAD and a PT_INTERP naming `interpreter`, as Claude Code's Linux build has. */
function elf(interpreter = GLIBC_INTERPRETER, machine = 183): Buffer {
  const file = Buffer.alloc(176 + interpreter.length + 1 + 32, 0xaa);
  file.fill(0, 0, 176);
  file.writeUInt32BE(0x7f454c46, 0);
  file[4] = 2;
  file[5] = 1;
  file.writeUInt16LE(machine, 18);
  file.writeBigUInt64LE(64n, 32);
  file.writeUInt16LE(56, 54);
  file.writeUInt16LE(2, 56);
  file.writeUInt32LE(1, 64);
  file.writeUInt32LE(3, 120);
  file.writeBigUInt64LE(176n, 128);
  file.writeBigUInt64LE(BigInt(interpreter.length + 1), 152);
  file.write(`${interpreter}\0`, 176, 'latin1');
  return file;
}

test('Claude Code\'s interpreter is renamed in place to the glibc loader link, and nothing else moves', () => {
  const link = loaderLink('/data/data/com.termux/files/usr');
  expect(link).toBe('/data/data/com.termux/ld');
  const dir = temporary();
  try {
    const file = join(dir, 'claude');
    const original = elf();
    writeFileSync(file, original);
    expect(patchInterpreter(file, link)).toBe('patched');
    const patched = readFileSync(file);
    expect(patched.length).toBe(original.length);
    expect(patched.subarray(176, 176 + GLIBC_INTERPRETER.length + 1).toString('latin1')).toBe(`${link}\0\0\0`);
    expect(Buffer.concat([patched.subarray(0, 176), patched.subarray(203)])).toEqual(Buffer.concat([original.subarray(0, 176), original.subarray(203)]));
    expect(patchInterpreter(file, link)).toBe('already');

    writeFileSync(file, elf(GLIBC_INTERPRETER, 62));
    expect(() => patchInterpreter(file, link)).toThrow('ARM');
    writeFileSync(file, elf('/lib64/ld-linux-x86-64.so.2'));
    expect(() => patchInterpreter(file, link)).toThrow(`expected ${GLIBC_INTERPRETER}`);
    writeFileSync(file, elf());
    expect(() => patchInterpreter(file, '/data/data/com.termux/files/usr/glibc/lib/ld.so')).toThrow('does not fit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a recorded PID counts only while its start time is the one recorded, whatever the command name holds', () => {
  const stat = '4242 (a) b) S 1 4242 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 987654 12345678 300 18446744073709551615';
  expect(startTimeOf(stat)).toBe('987654');
  expect(startTimeOf('garbage')).toBeNull();
});

test('the core listens and is reached on the Wi-Fi and the tailnet, never on mobile data', () => {
  const entry = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null });
  // The carrier's address on rmnet falls in Tailscale's range too, and comes first.
  const phone = {
    lo: [entry('127.0.0.1', true)],
    rmnet_data1: [entry('100.71.12.9')],
    wlan0: [entry('192.168.1.97')],
    tun0: [entry('100.101.5.7')],
  } as unknown as Interfaces;
  expect(tailscaleAddress(phone)).toBe('100.101.5.7');
  expect(bindAddress('tailscale', phone)).toBe('100.101.5.7');
  expect(bindAddress('lan', phone)).toBe('0.0.0.0');
  expect(bindAddress('local', phone)).toBe('127.0.0.1');
  expect(reachableAt('lan', 7337, phone)).toEqual(['http://192.168.1.97:7337', 'http://100.101.5.7:7337']);
  expect(reachableAt('local', 7337, phone)).toEqual(['http://127.0.0.1:7337']);

  const offline = { lo: phone.lo, rmnet_data1: phone.rmnet_data1 } as unknown as Interfaces;
  expect(bindAddress('tailscale', offline)).toBeNull();
  expect(reachableAt('tailscale', 7337, offline)).toEqual([]);

  // The core may name the carrier's address in its link: the grant goes on every address this phone is reached at.
  const link = 'http://10.71.12.9:7337/?grant=abc';
  expect(pairingLinks(link, reachableAt('lan', 7337, phone))).toEqual(['http://192.168.1.97:7337/?grant=abc', 'http://100.101.5.7:7337/?grant=abc']);
  expect(pairingLinks(link, [])).toEqual([link]);
});

test('a setting is refused with the expected values rather than saved half-valid', () => {
  expect(parseConfig('{}')).toEqual({ channel: 'stable', host: 'lan', port: 7337, autostart: true, name: null });
  const config = parseConfig('{"channel":"nightly"}');
  expect(withSetting(config, 'autostart', 'off').autostart).toBe(false);
  expect(withSetting(config, 'port', '8080').port).toBe(8080);
  expect(() => withSetting(config, 'port', '80')).toThrow('1024 to 65535');
  expect(() => withSetting(config, 'host', 'wifi')).toThrow('lan, tailscale, local');
  expect(() => withSetting(config, 'colour', 'blue')).toThrow('channel, host, port, autostart or name');
  expect(() => parseConfig('[]', 'config.json')).toThrow('config.json must hold a JSON object');
  // A name the user gives is trimmed; an empty one hands the phone's own back.
  const named = withSetting(config, 'name', '  OnePlus 7 Pro ');
  expect(named.name).toBe('OnePlus 7 Pro');
  expect(withSetting(named, 'name', ' ').name).toBeNull();
  expect(() => withSetting(config, 'name', 'x'.repeat(101))).toThrow('at most 100 characters');
  expect(() => parseConfig('{"name":7}', 'config.json')).toThrow('config.json: name must be text');
});

test('the phone goes by its maker and model, said once when the model already names the maker', () => {
  const props = (values: Record<string, string>) => (property: string) => values[property] ?? '';
  expect(deviceName(props({ 'ro.product.manufacturer': 'OnePlus', 'ro.product.model': 'GM1913\n' }))).toBe('OnePlus GM1913');
  expect(deviceName(props({ 'ro.product.manufacturer': 'Google', 'ro.product.model': 'Pixel 8' }))).toBe('Google Pixel 8');
  expect(deviceName(props({ 'ro.product.manufacturer': 'OnePlus', 'ro.product.model': 'ONEPLUS A6003' }))).toBe('ONEPLUS A6003');
  expect(deviceName(props({}))).toBeNull();
});

test('the core gets the name boite-server picked, and none exported in the shell when it picked none', () => {
  const release = { version: '2.0.0', dir: '/releases/2.0.0', bun: { version: '1.4.4', sha256: '' } };
  const before = process.env.BOITE_MACHINE_NAME;
  process.env.BOITE_MACHINE_NAME = 'Exported';
  try {
    expect(coreEnv(release, DEFAULT_CONFIG, 'OnePlus GM1913').BOITE_MACHINE_NAME).toBe('OnePlus GM1913');
    expect('BOITE_MACHINE_NAME' in coreEnv(release, DEFAULT_CONFIG, null)).toBe(false);
  } finally {
    if (before === undefined) delete process.env.BOITE_MACHINE_NAME;
    else process.env.BOITE_MACHINE_NAME = before;
  }
});
