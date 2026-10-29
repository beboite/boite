/**
 * `boite device`: the agent's side of the Device panel, the counterpart of
 * T3 Code's device_list, device_open, device_screenshot and device_close.
 * Every command speaks for the agent's own conversation; the core runs the SDK.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MOBILE_DEVICE_KEYS, mobileDeviceInputError, type MobileDeviceInput, type MobileDeviceKey, type MobileDeviceSession, type MobilePlatform } from '@boite/contracts';
import type { CoreClient } from './client.ts';
import type { CliIo } from './cli.ts';
import { Usage } from './cli-args.ts';

/** The exact request an agent makes when a phone would need the live stream. */
export const STREAM_REQUEST = 'boite settings request deviceStream true --why "<what the live stream is for>"';
const STREAM_HINT = `The live stream is off by default; to ask the owner for it: ${STREAM_REQUEST}`;

export const DEVICE_HELP = `boite device <command> [args] [--json]
  list                           iOS Simulators and Android emulators or phones on
                                 this machine, which platforms it runs, and what
                                 this conversation's Device panel has open
  open [device-id] [--platform android|ios]
                                 boot it if needed and show it live in the user's
                                 Device panel; waits until it is ready (--timeout <s>,
                                 default 200) and prints the command that drives it
  screenshot [device-id] [--output <path>]
                                 save the screen as a PNG (default: unique name in cwd)
  tap <x> <y> [device-id]        tap at screen pixels, as in a full-size screenshot
  swipe <x1> <y1> <x2> <y2> [ms] [device-id]
  type <text> [device-id]        type text: any Unicode while the live stream is up,
                                 printable ASCII through adb input otherwise
  key ${MOBILE_DEVICE_KEYS.join('|')} [device-id]
  close [device-id] [--shutdown] remove it from the panel; --shutdown powers it off
Without a device-id, commands use the conversation's only open device.
tap, swipe, type and key reach Android only; iOS Simulators are view-only in the
panel: drive them with the xcrun simctl prefix that open prints.
While the user watches an Android device with the live stream on, tap, swipe,
type and key go through its scrcpy session (real touches, Unicode text);
otherwise through adb shell input. screenshot always uses adb screencap.
${STREAM_HINT}
Use boite attach <file.png> to show a screenshot in chat.`;

export interface DeviceCliResult {
  lines: string[];
  value: unknown;
}

/** As the agent's shell reads it: a Windows path holds no quote, a POSIX one is single-quoted like terminals.ts. */
const quote = (arg: string) => process.platform === 'win32'
  ? (/\s/.test(arg) ? `"${arg}"` : arg)
  : (/^[\w.:/=@-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

function flag(rest: string[], name: string): string | undefined {
  const at = rest.indexOf(name);
  if (at === -1) return undefined;
  const value = rest[at + 1];
  if (!value || value.startsWith('--')) throw new Usage(`device ${name} needs a value`);
  rest.splice(at, 2);
  if (rest.includes(name)) throw new Usage(`device accepts one ${name}`);
  return value;
}

function pixel(raw: string | undefined, what: string): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value < 0) throw new Usage(`device ${what} needs a whole number of screen pixels`);
  return value;
}

function sessionLine(session: MobileDeviceSession): string {
  const error = session.error ? `: ${session.error}` : '';
  return `${session.deviceId} ${session.platform} ${session.state}${error} (${session.name}${session.input ? '' : ', view-only'})`;
}

function optional(rest: string[], count: number): string | undefined {
  if (rest.length > count + 1) throw new Usage(DEVICE_HELP);
  return rest[count];
}

async function listDevices(rest: string[], client: CoreClient, threadId: string): Promise<DeviceCliResult> {
  if (rest.length > 0) throw new Usage(DEVICE_HELP);
  const list = await client.call('devices.list', { threadId });
  const lines: string[] = [];
  for (const host of list.hosts) {
    lines.push(`host ${host.id} (${host.name})`);
    for (const p of host.platforms) lines.push(`  ${p.platform}: ${p.available ? 'available' : 'unavailable'}${p.reason ? ` - ${p.reason}` : ''}`);
  }
  if (list.devices.length === 0) lines.push('devices: none. No simulators or emulators were found on this machine.');
  for (const d of list.devices) lines.push(`${d.id} ${d.platform} ${d.kind} ${d.state} (${d.name}${d.runtime ? `, ${d.runtime}` : ''})`);
  lines.push(list.sessions.length === 0 ? 'open here: none' : `open here: ${list.sessions.map((s) => `${s.deviceId} (${s.state})`).join(', ')}`);
  if (list.liveStream === false && list.devices.some((d) => d.platform === 'android' && d.kind === 'physical')) {
    lines.push(`hint: the live stream is off, so a phone gets screenshots and adb input only; to ask for it: ${STREAM_REQUEST}`);
  }
  return { lines, value: list };
}

async function openDevice(rest: string[], client: CoreClient, threadId: string, timeoutS: number): Promise<DeviceCliResult> {
  const platform = flag(rest, '--platform');
  if (platform !== undefined && platform !== 'android' && platform !== 'ios') throw new Usage('device open --platform expects android or ios');
  const deviceId = optional(rest, 0);
  const { session } = await client.call('devices.open', {
    threadId,
    ...(deviceId === undefined ? {} : { deviceId }),
    ...(platform === undefined ? {} : { platform: platform as MobilePlatform }),
  });
  const deadline = Date.now() + timeoutS * 1000;
  let current = session;
  let control: string[] | undefined;
  while (current.state === 'booting') {
    if (Date.now() > deadline) throw new Error(`${current.name} is still starting after ${timeoutS} seconds; boite device list shows its state`);
    await Bun.sleep(1000);
    const state = await client.call('devices.sessions', { threadId });
    const found = state.sessions.find((s) => s.deviceId === session.deviceId);
    if (!found) throw new Error(`${session.name} was closed while it started`);
    current = found;
    control = state.control?.[found.deviceId];
  }
  if (current.state === 'failed') throw new Error(`${current.name} failed to start: ${current.error ?? 'no reason given'}`);
  if (!control) control = (await client.call('devices.sessions', { threadId })).control?.[current.deviceId];
  const drive = control ? control.map(quote).join(' ') : undefined;
  const lines = [sessionLine(current), 'shown: in the Device panel of this conversation'];
  if (drive) {
    lines.push(`control: ${drive}`);
    lines.push(current.platform === 'android'
      ? `  e.g. ${drive} shell uiautomator dump /dev/tty, ${drive} shell am start -n <package>/<activity>, ${drive} install <app.apk>`
      : `  e.g. ${drive} launch ${current.deviceId} <bundle-id>, ${drive} openurl ${current.deviceId} <url>, ${drive} install ${current.deviceId} <app>`);
  }
  return { lines, value: { session: current, control } };
}

async function screenshotDevice(rest: string[], io: CliIo, client: CoreClient, threadId: string): Promise<DeviceCliResult> {
  const output = flag(rest, '--output');
  const deviceId = optional(rest, 0);
  const shot = await client.call('devices.screenshot', { threadId, ...(deviceId === undefined ? {} : { deviceId }) });
  const bytes = Buffer.from(shot.base64, 'base64');
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('the device returned a non-PNG screenshot');
  const path = resolve(io.cwd, output ?? `boite-device-${crypto.randomUUID()}.png`);
  writeFileSync(path, bytes, { flag: 'wx' });
  const value = { deviceId: shot.deviceId, path, width: shot.width, height: shot.height, bytes: bytes.length };
  return { lines: [`path: ${path}`, `size: ${shot.width}x${shot.height} pixels`], value };
}

function swipeInput(rest: string[]): { deviceId: string | undefined; value: MobileDeviceInput } {
  const coords = [0, 1, 2, 3].map((i) => pixel(rest[i], 'swipe'));
  const extra = rest.slice(4);
  const duration = extra[0] !== undefined && /^\d+$/.test(extra[0]) ? Number(extra.shift()) : undefined;
  if (extra.length > 1) throw new Usage(DEVICE_HELP);
  return { deviceId: extra[0], value: { kind: 'swipe', from: { x: coords[0]!, y: coords[1]! }, to: { x: coords[2]!, y: coords[3]! }, ...(duration === undefined ? {} : { durationMs: duration }) } };
}

export async function deviceCommand(args: string[], io: CliIo, client: CoreClient, threadId: string, timeoutS = 200): Promise<DeviceCliResult> {
  const [command = 'list', ...rest] = args;
  if (command === 'help') return { lines: [DEVICE_HELP], value: { help: DEVICE_HELP } };
  const input = async (deviceId: string | undefined, value: MobileDeviceInput) => {
    const problem = mobileDeviceInputError(value);
    if (problem) throw new Usage(problem);
    const id = deviceId ?? (await only());
    const { via } = await client.call('devices.input', { threadId, deviceId: id, input: value });
    return { lines: [`ok: ${value.kind} on ${id}${via === 'stream' ? ' (live stream)' : ''}`], value: { ok: true, deviceId: id, ...(via ? { via } : {}) } };
  };
  const only = async () => {
    const { sessions } = await client.call('devices.sessions', { threadId });
    if (sessions.length === 1) return sessions[0]!.deviceId;
    throw new Error(sessions.length === 0 ? 'no device is open in this conversation; run boite device open' : `several devices are open; name one: ${sessions.map((s) => s.deviceId).join(', ')}`);
  };

  switch (command) {
    case 'list': return listDevices(rest, client, threadId);
    case 'open': return openDevice(rest, client, threadId, timeoutS);
    case 'screenshot': return screenshotDevice(rest, io, client, threadId);
    case 'tap': return input(optional(rest, 2), { kind: 'tap', x: pixel(rest[0], 'tap x'), y: pixel(rest[1], 'tap y') });
    case 'swipe': {
      const { deviceId, value } = swipeInput(rest);
      return input(deviceId, value);
    }
    case 'type': {
      if (!rest[0]) throw new Usage('device type needs text');
      return input(optional(rest, 1), { kind: 'text', text: rest[0] });
    }
    case 'key': {
      if (!rest[0]) throw new Usage(`device key needs one of ${MOBILE_DEVICE_KEYS.join(', ')}`);
      return input(optional(rest, 1), { kind: 'key', key: rest[0] as MobileDeviceKey });
    }
    case 'close': {
      const at = rest.indexOf('--shutdown');
      const shutdown = at !== -1;
      if (shutdown) rest.splice(at, 1);
      const deviceId = optional(rest, 0);
      const result = await client.call('devices.close', { threadId, ...(deviceId === undefined ? {} : { deviceId }), ...(shutdown ? { shutdown } : {}) });
      return { lines: [`closed: ${result.closed.join(', ')}${shutdown ? ' (powered off)' : ''}`], value: result };
    }
    default: throw new Usage(DEVICE_HELP);
  }
}
