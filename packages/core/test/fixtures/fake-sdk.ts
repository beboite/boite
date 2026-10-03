/**
 * A stand-in for the Android SDK's `adb` and `emulator` and for Xcode's
 * `xcrun simctl`, so the Device panel runs its whole cycle on a machine with
 * neither. `fakeSdk()` lays out an SDK folder whose `platform-tools/adb`,
 * `emulator/emulator` and `xcode/xcrun` are shell or .cmd wrappers that run
 * this file as `bun fake-sdk.ts <root> <tool> ...args`. State lives in
 * `<root>/state.json`, and each call is appended to `<root>/calls.log`.
 * Never touches a real device.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

export interface FakeSdkState {
  avds: string[];
  /** Running emulators: serial to AVD name, and when each finishes booting. */
  running: Record<string, { avd: string; bootedAt: number }>;
  physical?: { serial: string; model: string }[];
  sims?: { udid: string; name: string; runtime: string; state: 'Booted' | 'Shutdown'; isAvailable?: boolean }[];
  /** How long a started emulator takes to report `sys.boot_completed`. */
  bootMs?: number;
  /** `emulator -avd` exits at once with this message instead of booting. */
  emulatorFails?: string;
}

export const SCREEN = { width: 108, height: 240 };

/** A solid PNG the size of a small phone screen. */
export function png(width = SCREEN.width, height = SCREEN.height): Uint8Array {
  const row = new Uint8Array(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([40, 120, 200], 1 + x * 3);
  const raw = new Uint8Array(row.length * height);
  for (let y = 0; y < height; y++) raw.set(row, y * row.length);
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array(4 + data.length);
    body.set(new TextEncoder().encode(type), 0);
    body.set(data, 4);
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(body, 4);
    view.setUint32(8 + data.length, Bun.hash.crc32(body));
    return out;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

/** Lays out a fake SDK and returns its root, its Xcode folder and a reader for its call log. */
export function fakeSdk(state: Partial<FakeSdkState> = {}, tools: { adb?: boolean; emulator?: boolean; xcrun?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'boite-fake-sdk-'));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ avds: [], running: {}, ...state }));
  const wrap = (folder: string, tool: string) => {
    mkdirSync(join(root, folder), { recursive: true });
    if (process.platform === 'win32') {
      writeFileSync(join(root, folder, `${tool}.cmd`), `@"${process.execPath}" "${import.meta.path}" "${root}" ${tool} %*\r\n`);
    } else {
      const file = join(root, folder, tool);
      writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${import.meta.path}" "${root}" ${tool} "$@"\n`);
      chmodSync(file, 0o755);
    }
  };
  if (tools.adb !== false) wrap('platform-tools', 'adb');
  if (tools.emulator !== false) wrap('emulator', 'emulator');
  if (tools.xcrun) wrap('xcode', 'xcrun');
  return {
    root,
    xcode: join(root, 'xcode'),
    calls: () => (existsSync(join(root, 'calls.log')) ? readFileSync(join(root, 'calls.log'), 'utf8').trim().split('\n') : []),
    state: () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as FakeSdkState,
    /** Ends every fake emulator process, which watch the state for their serial. */
    stopEmulators: () => {
      const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as FakeSdkState;
      writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, running: {} }));
    },
  };
}

async function main(root: string, tool: string, args: string[]): Promise<number> {
  const statePath = join(root, 'state.json');
  const read = () => JSON.parse(readFileSync(statePath, 'utf8')) as FakeSdkState;
  const write = (state: FakeSdkState) => writeFileSync(statePath, JSON.stringify(state));
  appendFileSync(join(root, 'calls.log'), `${tool} ${args.join(' ')}\n`);
  const out = (text: string) => process.stdout.write(text);
  const state = read();

  if (tool === 'emulator') {
    if (args[0] === '-list-avds') { out(`INFO    | Storing crashdata in: /tmp/android/emu-crash.db\n${state.avds.join('\n')}\n`); return 0; }
    if (args[0] !== '-avd' || !args[1]) { process.stderr.write('unknown emulator call\n'); return 1; }
    if (state.emulatorFails) { process.stderr.write(`${state.emulatorFails}\n`); return 1; }
    let port = 5554;
    while (state.running[`emulator-${port}`]) port += 2;
    const serial = `emulator-${port}`;
    state.running[serial] = { avd: args[1], bootedAt: Date.now() + (state.bootMs ?? 200) };
    write(state);
    // Runs until `adb emu kill` takes it off the list, like the real window; never longer than 30 s.
    const started = Date.now();
    while (Date.now() - started < 30_000 && read().running[serial]) await Bun.sleep(100);
    return 0;
  }

  if (tool === 'adb') {
    let serial: string | undefined;
    if (args[0] === '-s') { serial = args[1]; args = args.slice(2); }
    if (args[0] === 'devices') {
      const lines = ['List of devices attached'];
      for (const [id] of Object.entries(state.running)) lines.push(`${id}\tdevice product:sdk_gphone64 model:sdk_gphone64_x86_64 transport_id:1`);
      for (const phone of state.physical ?? []) lines.push(`${phone.serial}\tdevice usb:1-1 product:x model:${phone.model} transport_id:2`);
      out(`${lines.join('\n')}\n\n`);
      return 0;
    }
    const physical = state.physical?.some((phone) => phone.serial === serial);
    const emulator = serial ? state.running[serial] : undefined;
    if (!emulator && !physical) { process.stderr.write(`adb: device '${serial}' not found\n`); return 1; }
    if (args[0] === 'emu') {
      if (!emulator) { process.stderr.write('not an emulator\n'); return 1; }
      if (args[1] === 'avd' && args[2] === 'name') { out(`${emulator.avd}\r\nOK\r\n`); return 0; }
      if (args[1] === 'kill') { delete state.running[serial!]; write(state); out('OK: killing emulator, bye bye\r\n'); return 0; }
      if (args[1] === 'rotate') { out('OK\r\n'); return 0; }
    }
    if (args[0] === 'shell' && args[1] === 'getprop' && args[2] === 'sys.boot_completed') {
      out(!emulator || Date.now() >= emulator.bootedAt ? '1\n' : '\n');
      return 0;
    }
    if (args[0] === 'exec-out' && args[1] === 'screencap') { process.stdout.write(png()); return 0; }
    if (args[0] === 'shell' && args[1] === 'input') return 0;
    process.stderr.write(`unknown adb call ${args.join(' ')}\n`);
    return 1;
  }

  if (tool === 'xcrun' && args[0] === 'simctl') {
    const sims = state.sims ?? [];
    const sim = sims.find((entry) => entry.udid === args[1] || entry.udid === args[2]);
    switch (args[1]) {
      case 'list': {
        const devices: Record<string, unknown[]> = {};
        for (const entry of sims) (devices[entry.runtime] ??= []).push({ udid: entry.udid, name: entry.name, state: entry.state, isAvailable: entry.isAvailable ?? true });
        out(JSON.stringify({ devices }));
        return 0;
      }
      case 'boot':
        if (!sim) return 1;
        if (sim.state === 'Booted') { process.stderr.write('Unable to boot device in current state: Booted\n'); return 149; }
        sim.state = 'Booted'; write(state); return 0;
      case 'bootstatus': return sim?.state === 'Booted' ? 0 : 1;
      case 'shutdown': if (!sim) return 1; sim.state = 'Shutdown'; write(state); return 0;
      case 'io': if (sim?.state !== 'Booted') return 1; process.stdout.write(png()); return 0;
    }
  }
  process.stderr.write(`unknown call ${tool} ${args.join(' ')}\n`);
  return 1;
}

if (import.meta.main) {
  const [root, tool, ...args] = process.argv.slice(2);
  process.exitCode = await main(root!, tool!, args);
}
