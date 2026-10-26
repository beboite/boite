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
  /** The color every screen shows; a new one is a changed screen. */
  screen?: [number, number, number];
  /** `adb reverse` tunnels in place: device socket to the core's `tcp:` port. */
  reverses?: Record<string, number>;
  /** What `adb shell wm size` reports; 1080x2400 by default. */
  wmSize?: string;
  /** The fake scrcpy server prints this and exits instead of connecting. */
  scrcpyFails?: string;
  /** The server jar pushed to each serial; the fake server deletes it when it starts, as `cleanup=true` does. */
  pushed?: Record<string, string>;
  /** What the device's clipboard holds when the fake scrcpy server starts. */
  clipboard?: string;
  /** The fake scrcpy server sets the clipboard it is sent but never confirms it. */
  clipboardUnconfirmed?: boolean;
  /** Delays the server's final log and exit, so the core must enforce its shutdown deadline. */
  scrcpyExitDelayMs?: number;
}

/** A control message the fake scrcpy server received, decoded. */
export type ScrcpyControl =
  | { type: 'key'; action: number; keycode: number }
  | { type: 'text'; text: string }
  | { type: 'touch'; action: number; pointer: number; x: number; y: number; width: number; height: number; pressure: number }
  | { type: 'scroll'; x: number; y: number; width: number; height: number; h: number; v: number }
  | { type: 'getClipboard'; copy: number }
  | { type: 'setClipboard'; sequence: number; paste: boolean; text: string }
  | { type: 'rotate' };

/** The recorded stream the fake scrcpy server sends: 144x320, 8 frames, a key frame every 4. */
export const SCRCPY_VIDEO = { path: join(import.meta.dir, 'scrcpy-video.h264'), width: 144, height: 320 };

/** The fixture's config (SPS and PPS) and its frames, each one Annex B access unit, as scrcpy sends them. */
export function scrcpyPackets(bytes: Uint8Array = readFileSync(SCRCPY_VIDEO.path)): { config: Uint8Array; frames: { key: boolean; data: Uint8Array }[] } {
  const starts: number[] = [];
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && (bytes[i + 2] === 1 || (bytes[i + 2] === 0 && bytes[i + 3] === 1))) {
      starts.push(i);
      i += 2;
    }
  }
  const config: Uint8Array[] = [];
  const frames: { key: boolean; data: Uint8Array }[] = [];
  starts.forEach((start, n) => {
    const nal = bytes.subarray(start, starts[n + 1] ?? bytes.length);
    const header = nal[nal[2] === 1 ? 3 : 4]!;
    const type = header & 0x1f;
    if (type === 7 || type === 8) config.push(nal);
    else if (type === 1 || type === 5) frames.push({ key: type === 5, data: nal });
  });
  return { config: Buffer.concat(config), frames };
}

export const SCREEN = { width: 108, height: 240 };

/** A solid PNG the size of a small phone screen. */
export function png(width = SCREEN.width, height = SCREEN.height, color: [number, number, number] = [40, 120, 200]): Uint8Array {
  const row = new Uint8Array(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(color, 1 + x * 3);
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
    /** Changes what every screen shows from the next capture on. */
    paint: (screen: [number, number, number]) => {
      const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as FakeSdkState;
      writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, screen }));
    },
    /** Ends every fake emulator process, which watch the state for their serial. */
    stopEmulators: () => {
      const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as FakeSdkState;
      writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, running: {} }));
    },
    /** Changes what the fake device and its scrcpy server do from the next call on. */
    set: (change: Partial<FakeSdkState>) => {
      const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as FakeSdkState;
      writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, ...change }));
    },
    /** The control messages every fake scrcpy server received, in order. */
    controls: (): ScrcpyControl[] => (existsSync(join(root, 'control.log')) ? readFileSync(join(root, 'control.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []),
    /** `start <scid>` and `exit <scid>` for each fake scrcpy server. */
    servers: () => (existsSync(join(root, 'scrcpy.log')) ? readFileSync(join(root, 'scrcpy.log'), 'utf8').trim().split('\n') : []),
  };
}

/** Plays the scrcpy server: connects video then control to the reversed port and serves the recorded stream. */
async function scrcpyServer(root: string, serial: string, state: FakeSdkState, args: string[]): Promise<number> {
  const scid = args.find((arg) => arg.startsWith('scid='))?.slice(5);
  const port = scid ? state.reverses?.[`localabstract:scrcpy_${scid}`] : undefined;
  if (state.scrcpyFails) { process.stderr.write(`${state.scrcpyFails}\n`); return 1; }
  if (!port) { process.stderr.write(`[server] ERROR: no tunnel for scid ${scid}\n`); return 1; }
  const jar = args.find((arg) => arg.startsWith('CLASSPATH='))?.slice(10);
  if (!jar || state.pushed?.[serial] !== jar) { process.stderr.write('Error: Could not find or load main class com.genymobile.scrcpy.Server\n'); return 1; }
  delete state.pushed![serial];
  writeFileSync(join(root, 'state.json'), JSON.stringify(state));
  const log = (line: string) => appendFileSync(join(root, 'scrcpy.log'), `${line}\n`);
  log(`start ${scid}`);
  process.stdout.write('[server] INFO: Device: [fake] Boite Phone (Android 15)\n');
  const { connect } = await import('node:net');
  const open = () => new Promise<import('node:net').Socket>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => resolve(socket));
    socket.once('error', reject);
  });
  const video = await open();
  const control = await open();
  let done!: () => void;
  const ended = new Promise<void>((resolve) => { done = resolve; });
  for (const socket of [video, control]) { socket.on('close', () => done()); socket.on('error', () => done()); }

  let clipboard = state.clipboard ?? '';
  let pending: Uint8Array = new Uint8Array(0);
  control.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const view = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
      if (view.byteLength < 1) break;
      const type = view.getUint8(0);
      const text = (at: number) => (view.byteLength >= at + 4 && view.byteLength >= at + 4 + view.getUint32(at) ? new TextDecoder().decode(pending.subarray(at + 4, at + 4 + view.getUint32(at))) : undefined);
      let size: number;
      let message: ScrcpyControl;
      if (type === 0) {
        if (view.byteLength < 14) break;
        size = 14; message = { type: 'key', action: view.getUint8(1), keycode: view.getInt32(2) };
      } else if (type === 1) {
        const value = text(1);
        if (value === undefined) break;
        size = 5 + view.getUint32(1); message = { type: 'text', text: value };
      } else if (type === 2) {
        if (view.byteLength < 32) break;
        size = 32;
        message = { type: 'touch', action: view.getUint8(1), pointer: Number(view.getBigInt64(2)), x: view.getInt32(10), y: view.getInt32(14), width: view.getUint16(18), height: view.getUint16(20), pressure: view.getUint16(22) };
      } else if (type === 3) {
        if (view.byteLength < 21) break;
        size = 21;
        message = { type: 'scroll', x: view.getInt32(1), y: view.getInt32(5), width: view.getUint16(9), height: view.getUint16(11), h: view.getInt16(13), v: view.getInt16(15) };
      } else if (type === 8) {
        if (view.byteLength < 2) break;
        size = 2; message = { type: 'getClipboard', copy: view.getUint8(1) };
        const body = new TextEncoder().encode(clipboard);
        const reply = new DataView(new ArrayBuffer(5 + body.length));
        reply.setUint32(1, body.length);
        const bytes = new Uint8Array(reply.buffer);
        bytes.set(body, 5);
        control.write(bytes);
      } else if (type === 9) {
        const value = text(10);
        if (value === undefined) break;
        size = 14 + view.getUint32(10);
        const sequence = Number(view.getBigUint64(1));
        message = { type: 'setClipboard', sequence, paste: view.getUint8(9) === 1, text: value };
        clipboard = value;
        if (sequence > 0 && !state.clipboardUnconfirmed) {
          const ack = new DataView(new ArrayBuffer(9));
          ack.setUint8(0, 1);
          ack.setBigUint64(1, BigInt(sequence));
          control.write(new Uint8Array(ack.buffer));
        }
      } else if (type === 11) {
        size = 1; message = { type: 'rotate' };
      } else {
        process.stderr.write(`[server] ERROR: unknown control message ${type}\n`);
        control.destroy();
        return;
      }
      appendFileSync(join(root, 'control.log'), `${JSON.stringify(message)}\n`);
      pending = pending.subarray(size);
    }
  });

  const header = (head: bigint, size: number) => {
    const view = new DataView(new ArrayBuffer(12));
    view.setBigUint64(0, head);
    view.setUint32(8, size);
    return new Uint8Array(view.buffer);
  };
  const codec = new DataView(new ArrayBuffer(4));
  codec.setUint32(0, 0x68_32_36_34);
  video.write(new Uint8Array(codec.buffer));
  const session = new DataView(new ArrayBuffer(12));
  session.setUint32(0, 0x8000_0000);
  session.setUint32(4, SCRCPY_VIDEO.width);
  session.setUint32(8, SCRCPY_VIDEO.height);
  video.write(new Uint8Array(session.buffer));
  const { config, frames } = scrcpyPackets();
  video.write(header(1n << 62n, config.length));
  video.write(config);
  // Loops the recording at 10 fps, as a screen that keeps changing, until the core closes a socket,
  // the phone is unplugged (gone from `physical`) or 60 s pass.
  let frame = 0;
  const started = Date.now();
  let closed = false;
  void ended.then(() => { closed = true; });
  const plugged = () => {
    try {
      const now = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as FakeSdkState;
      return !state.physical?.some((phone) => phone.serial === serial) || now.physical?.some((phone) => phone.serial === serial);
    } catch {
      return true; // read while another fake call rewrote it
    }
  };
  while (!closed && Date.now() - started < 60_000) {
    if (!plugged()) { process.stderr.write('[server] ERROR: device offline\n'); log(`unplugged ${scid}`); process.exit(1); }
    const { key, data } = frames[frame % frames.length]!;
    const pts = BigInt(frame * 100_000);
    video.write(header((key ? 1n << 61n : 0n) | pts, data.length));
    video.write(data);
    frame++;
    await Promise.race([Bun.sleep(100), ended]);
  }
  video.destroy();
  control.destroy();
  if (state.scrcpyExitDelayMs) await Bun.sleep(state.scrcpyExitDelayMs);
  log(`exit ${scid}`);
  return 0;
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
    if (args[0] === 'exec-out' && args[1] === 'screencap') { process.stdout.write(png(SCREEN.width, SCREEN.height, state.screen)); return 0; }
    if (args[0] === 'shell' && args[1] === 'input') return 0;
    if (args[0] === 'push' && args[1] && args[2]) {
      if (!existsSync(args[1])) { process.stderr.write(`adb: error: cannot stat '${args[1]}': No such file or directory\n`); return 1; }
      out(`${args[1]}: 1 file pushed, 0 skipped.\n`);
      (state.pushed ??= {})[serial!] = args[2];
      write(state);
      return 0;
    }
    if (args[0] === 'shell' && args[1] === 'wm' && args[2] === 'size') { out(`Physical size: ${state.wmSize ?? '1080x2400'}\n`); return 0; }
    if (args[0] === 'reverse') {
      const reverses = (state.reverses ??= {});
      if (args[1] === '--remove' && args[2]) {
        if (!(args[2] in reverses)) { process.stderr.write(`adb: error: listener '${args[2]}' not found\n`); return 1; }
        delete reverses[args[2]];
      } else if (args[1] && args[2]?.startsWith('tcp:')) {
        reverses[args[1]] = Number(args[2].slice(4));
      } else {
        process.stderr.write(`unknown adb call ${args.join(' ')}\n`);
        return 1;
      }
      write(state);
      return 0;
    }
    if (args[0] === 'shell' && args[1]?.startsWith('CLASSPATH=') && args[2] === 'app_process') return scrcpyServer(root, serial!, state, args);
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
      case 'io': if (sim?.state !== 'Booted') return 1; process.stdout.write(png(SCREEN.width, SCREEN.height, state.screen)); return 0;
    }
  }
  process.stderr.write(`unknown call ${tool} ${args.join(' ')}\n`);
  return 1;
}

if (import.meta.main) {
  const [root, tool, ...args] = process.argv.slice(2);
  process.exitCode = await main(root!, tool!, args);
}
