/*
 * The Device panel's core half: the simulators and emulators this machine's
 * SDKs list, the ones each conversation has open, and their screens. Every SDK
 * command goes through `procs.spawn` as a tool process of `system:devices`;
 * a device is acted on only after the SDK listed it. See docs/devices.md.
 */
import {
  isAdbText,
  LOCAL_DEVICE_HOST,
  MOBILE_PLATFORMS,
  MOBILE_STREAM_SIZE,
  mobileDeviceIdError,
  mobileDeviceInputError,
  type MobileDevice,
  type MobileDeviceFrame,
  type MobileDeviceFrameUnchanged,
  type MobileDeviceInput,
  type MobileDeviceList,
  type MobileDeviceSession,
  type MobileDeviceStream,
  type MobileHostPlatform,
  type RpcParams,
  type RpcResult,
  type Settings,
  type ThreadId,
} from '@boite/contracts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';
import { runCommand, type CommandRun } from '../run-command.ts';
import { machineName } from '../paths.ts';
import type { Connection } from '../router.ts';
import {
  adbText,
  ANDROID_KEYCODES,
  currentSdkEnvironment,
  findAndroidSdk,
  findXcrun,
  parseAdbDevices,
  parseAvdList,
  parseAvdName,
  parseSimctlList,
  pngSize,
  type AndroidTools,
  type SdkEnvironment,
} from './sdk.ts';
import type { DeviceStreams, StreamOptions } from './stream.ts';

const SCOPE = 'system:devices';
/** What T3 Code waits too: a cold emulator takes a minute or two. */
export const BOOT_TIMEOUT_MS = 180_000;
const COMMAND_TIMEOUT_MS = 15_000;
/** A capture is shared by every viewer that asks within this long, so a phone and a desktop cost one screencap. */
const CAPTURE_REUSE_MS = 200;
const SESSIONS_MAX = 4;
/** Sizes and qualities remembered per device for `previous`: a desktop and a phone each ask their own. */
const FRAME_KINDS_MAX = 8;
/** Where `boite device` and the panel send someone whose stream is off. */
export const STREAM_OFF = 'the live stream is off: the owner turns it on in Settings > Experiments, or an agent asks with `boite settings request deviceStream true --why "..."`';


/** What a listed device needs to be driven: its adb serial or simulator UDID. */
interface Located extends MobileDevice {
  serial?: string;
}

/** A boot under way. `life` is the device's when it started; `serial` is set once adb sees the emulator. */
interface Boot {
  device: Located;
  life: number;
  serial?: string;
  promise: Promise<Located>;
}

interface Capture {
  at: number;
  /** `hash` is the SHA-1 of the PNG bytes: the same hash is the same screen. */
  png: Promise<{ bytes: Uint8Array; width: number; height: number; hash: string }>;
}

/** The last frame made from a device's screen at one size and quality. */
interface SentFrame {
  hash: string;
  id: string;
}

export interface MobileDevicesOptions {
  sdk?: () => SdkEnvironment;
  bootTimeoutMs?: number;
  pollMs?: number;
  stream?: StreamOptions;
}

export class MobileDevices {
  readonly #core: Core;
  readonly #sdk: () => SdkEnvironment;
  readonly #bootTimeoutMs: number;
  readonly #pollMs: number;
  /** Per conversation, what its panel has open, in opening order. */
  readonly #sessions = new Map<ThreadId, Map<string, MobileDeviceSession>>();
  /** The serial or UDID each open device answers to, once known. */
  readonly #targets = new Map<string, Located>();
  /** One boot per device, shared by every conversation that opens it meanwhile. */
  readonly #boots = new Map<string, Boot>();
  /** Advanced by each shutdown: a boot that started before it settles no session. */
  readonly #lives = new Map<string, number>();
  readonly #emulators = new Map<string, { kill(): void }>();
  readonly #captures = new Map<string, Capture>();
  /** Per device, by `maxWidth:quality`, the frame last made, so a caller still showing it gets `unchanged`. */
  readonly #frames = new Map<string, Map<string, SentFrame>>();
  readonly #streamOptions: StreamOptions | undefined;
  /** The live stream's sessions, loaded with stream.ts by the first `devices.stream`. */
  #streams?: Promise<DeviceStreams>;
  #live?: DeviceStreams;
  #offSettings?: () => void;
  #closed = false;

  constructor(core: Core, options: MobileDevicesOptions = {}) {
    this.#core = core;
    this.#sdk = options.sdk ?? currentSdkEnvironment;
    this.#bootTimeoutMs = options.bootTimeoutMs ?? BOOT_TIMEOUT_MS;
    this.#pollMs = options.pollMs ?? 2000;
    this.#streamOptions = options.stream;
  }

  async list({ threadId }: RpcParams<'devices.list'>, connection?: Connection): Promise<MobileDeviceList> {
    this.#thread(threadId, connection);
    const { host, devices } = await this.#discover();
    return { hosts: [host], devices: devices.map(({ serial: _serial, ...device }) => device), sessions: this.#list(threadId), liveStream: this.#streaming() };
  }

  sessions({ threadId }: RpcParams<'devices.sessions'>, connection?: Connection): RpcResult<'devices.sessions'> {
    this.#thread(threadId, connection);
    const sessions = this.#list(threadId);
    if (connection?.identity.principal === 'session') return { sessions };
    const control: Record<string, string[]> = {};
    for (const session of sessions) {
      const target = this.#targets.get(session.deviceId);
      if (session.state !== 'ready' || !target) continue;
      const prefix = this.#control(target);
      if (prefix) control[session.deviceId] = prefix;
    }
    return { sessions, control };
  }

  async open(params: RpcParams<'devices.open'>, connection?: Connection): Promise<RpcResult<'devices.open'>> {
    const { threadId } = params;
    this.#thread(threadId, connection);
    this.#host(params.hostId);
    if (params.deviceId !== undefined) this.#id(params.deviceId);
    if (params.platform !== undefined && !MOBILE_PLATFORMS.includes(params.platform)) throw refused('platform must be android or ios', { platform: params.platform });
    const { host, devices } = await this.#discover();
    const device = this.#choose(host.platforms, devices, params);
    const open = this.#sessions.get(threadId) ?? new Map<string, MobileDeviceSession>();
    const existing = open.get(device.id);
    if (existing && existing.state !== 'failed') return { session: { ...existing } };
    if (!existing && open.size >= SESSIONS_MAX) throw refused(`a conversation shows at most ${SESSIONS_MAX} devices; close one first`, { threadId });
    this.#core.logs.info(`Opening the ${device.platform} ${device.kind} device ${device.id} in the Device panel${existing ? ' again after a failure' : ''}`, { source: 'devices', event: 'device.opening', threadId, data: { deviceId: device.id, platform: device.platform, kind: device.kind, retry: existing !== undefined } });
    const session: MobileDeviceSession = {
      deviceId: device.id,
      hostId: LOCAL_DEVICE_HOST,
      platform: device.platform,
      name: device.name,
      state: 'booting',
      input: device.platform === 'android',
      openedAt: Date.now(),
    };
    open.set(device.id, session);
    this.#sessions.set(threadId, open);
    this.#changed(threadId);
    const boot = this.#boot(device);
    void boot.promise.then(
      (target) => {
        if (!this.#alive(boot)) return;
        this.#targets.set(device.id, target);
        this.#settle(device.id, { state: 'ready' });
      },
      (error: unknown) => {
        if (this.#alive(boot)) this.#core.logs.warn(`Device ${device.id} failed to boot: ${error instanceof Error ? error.message : String(error)}`, { source: 'devices', event: 'device.boot-failed', threadId, data: { deviceId: device.id, platform: device.platform } });
        if (this.#alive(boot)) this.#settle(device.id, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
      },
    );
    return { session: { ...session } };
  }

  /**
   * A frame keeps its id while the screen's PNG bytes stay the same at that size and quality. A caller
   * whose `previous` is that id gets `unchanged` with no picture, and the JPEG is not made again.
   */
  async frame(params: RpcParams<'devices.frame'>, connection?: Connection): Promise<MobileDeviceFrame | MobileDeviceFrameUnchanged> {
    const { threadId, deviceId, maxWidth, quality = 60, previous } = params;
    if (maxWidth !== undefined && !(Number.isInteger(maxWidth) && maxWidth >= 160 && maxWidth <= 3840)) throw refused('device frame maxWidth must be an integer from 160 to 3840');
    if (!(Number.isInteger(quality) && quality >= 20 && quality <= 90)) throw refused('device frame quality must be an integer from 20 to 90');
    if (previous !== undefined && !(typeof previous === 'string' && previous.length <= 100)) throw refused('device frame previous must be the id of a frame this device sent');
    const target = this.#ready(threadId, deviceId, connection);
    const png = await this.#capture(target);
    const kind = `${maxWidth ?? 0}:${quality}`;
    const sent = this.#frames.get(deviceId) ?? new Map<string, SentFrame>();
    const last = sent.get(kind);
    const same = last?.hash === png.hash ? last : undefined;
    if (same && previous === same.id) return { id: same.id, deviceId, width: png.width, height: png.height, unchanged: true, at: Date.now() };
    let image = new Bun.Image(png.bytes);
    if (maxWidth !== undefined && maxWidth < png.width) image = image.resize(maxWidth);
    const jpeg = await image.jpeg({ quality }).bytes();
    const id = same?.id ?? crypto.randomUUID();
    sent.delete(kind);
    sent.set(kind, { hash: png.hash, id });
    if (sent.size > FRAME_KINDS_MAX) sent.delete(sent.keys().next().value!);
    this.#frames.set(deviceId, sent);
    return { id, deviceId, width: png.width, height: png.height, base64: Buffer.from(jpeg).toString('base64'), at: Date.now() };
  }

  async screenshot(params: RpcParams<'devices.screenshot'>, connection?: Connection): Promise<RpcResult<'devices.screenshot'>> {
    this.#host(params.hostId);
    const deviceId = this.#only(params.threadId, params.deviceId, connection);
    const target = this.#ready(params.threadId, deviceId, connection);
    this.#captures.delete(deviceId);
    const png = await this.#capture(target);
    return { deviceId, width: png.width, height: png.height, base64: Buffer.from(png.bytes).toString('base64') };
  }

  /** Through the live stream's control socket while one is up, else `adb shell input`, which has no drag, wheel, clipboard or Unicode. */
  async input(params: RpcParams<'devices.input'>, connection?: Connection): Promise<RpcResult<'devices.input'>> {
    const problem = mobileDeviceInputError(params.input);
    if (problem) throw refused(problem);
    const target = this.#ready(params.threadId, params.deviceId, connection);
    if (target.platform !== 'android' || !target.serial) {
      throw refused('iOS Simulators are view-only in the Device panel; drive them with xcrun simctl from the agent', { deviceId: target.id });
    }
    if (this.#live?.live(target.id)) {
      await this.#live.input(target.id, params.input);
      this.#captures.delete(target.id);
      return { ok: true, via: 'stream' };
    }
    const input = params.input;
    const streamOnly = input.kind === 'touch' ? 'a touch' : input.kind === 'scroll' ? 'a scroll' : input.kind === 'clipboard' ? 'the device clipboard'
      : input.kind === 'text' && !isAdbText(input.text) ? 'text beyond printable ASCII' : undefined;
    if (streamOnly) {
      throw refused(`${streamOnly} needs the device's live stream (adb input cannot send it): ${this.#streaming() ? 'show the device in the Device panel to start it' : STREAM_OFF}`, { deviceId: target.id });
    }
    const args = this.#inputArgs(target, input);
    const run = await this.#run(this.#adb().adb, ['-s', target.serial, ...args], COMMAND_TIMEOUT_MS);
    if (run.code !== 0) throw refused(`adb ${args.slice(0, 3).join(' ')} failed: ${this.#why(run)}`, { deviceId: target.id });
    this.#captures.delete(target.id);
    return { ok: true, via: 'adb' };
  }

  /**
   * The long poll behind the panel's live video. Off, on an iOS Simulator, or
   * when the session fails, the answer says so and the panel polls frames.
   */
  async stream(params: RpcParams<'devices.stream'>, connection?: Connection): Promise<MobileDeviceStream> {
    const { threadId, deviceId, maxSize, after } = params;
    if (maxSize !== undefined && !(Number.isInteger(maxSize) && maxSize >= MOBILE_STREAM_SIZE.min && maxSize <= MOBILE_STREAM_SIZE.max)) {
      throw refused(`device stream maxSize must be an integer from ${MOBILE_STREAM_SIZE.min} to ${MOBILE_STREAM_SIZE.max}`);
    }
    if (after !== undefined && !(typeof after === 'object' && after !== null && typeof after.id === 'string' && after.id.length <= 100 && Number.isInteger(after.seq) && after.seq >= 0)) {
      throw refused('device stream after must be the id and seq of a chunk this device sent');
    }
    const target = this.#ready(threadId, deviceId, connection);
    if (!this.#streaming()) return { deviceId, state: 'off', reason: STREAM_OFF, chunks: [] };
    if (target.platform !== 'android' || !target.serial) return { deviceId, state: 'unavailable', reason: 'iOS Simulators have no live stream; the panel shows their screenshots', chunks: [] };
    const streams = await this.#loadStreams();
    // The setting may have gone off while stream.ts loaded.
    if (this.#closed || !this.#streaming()) return { deviceId, state: 'off', reason: STREAM_OFF, chunks: [] };
    // The panel may also have closed while the stream module was awaited.
    this.#ready(threadId, deviceId, connection);
    return streams.stream({ id: target.id, serial: target.serial, name: target.name }, connection?.id ?? 'core', { maxSize, after }, connection?.onClose?.bind(connection));
  }

  async clipboard(params: RpcParams<'devices.clipboard'>, connection?: Connection): Promise<RpcResult<'devices.clipboard'>> {
    if (params.copy !== undefined && params.copy !== 'copy' && params.copy !== 'cut') throw refused('device clipboard copy must be copy or cut');
    const target = this.#ready(params.threadId, params.deviceId, connection);
    if (target.platform !== 'android' || !target.serial) throw refused('the device clipboard needs an Android device: iOS Simulators have no live stream', { deviceId: target.id });
    if (!this.#live?.live(target.id)) {
      throw refused(`the device clipboard needs the live stream: ${this.#streaming() ? 'show the device in the Device panel to start it' : STREAM_OFF}`, { deviceId: target.id });
    }
    return { text: await this.#live.clipboard(target.id, params.copy) };
  }

  async close(params: RpcParams<'devices.close'>, connection?: Connection): Promise<RpcResult<'devices.close'>> {
    this.#host(params.hostId);
    const deviceId = this.#only(params.threadId, params.deviceId, connection);
    if (params.shutdown === true) {
      // A device still booting is powered off through the serial or UDID its boot knows.
      const boot = this.#boots.get(deviceId);
      const target = this.#targets.get(deviceId) ?? (boot?.serial ? { ...boot.device, serial: boot.serial } : undefined);
      if ((target ?? boot?.device)?.kind === 'physical') throw refused('a connected phone is not powered off from Boite; close it without shutdown', { deviceId });
      if (target) await this.#shutdown(target);
      this.#lives.set(deviceId, (this.#lives.get(deviceId) ?? 0) + 1);
      this.#boots.delete(deviceId);
      // Only a device that had a serial or UDID was powered off; one without was only closed.
      if (target) this.#core.logs.info(`Device ${deviceId} shut down from the Device panel`, { source: 'devices', event: 'device.shutdown', threadId: params.threadId, data: { deviceId } });
      else this.#core.logs.info(`Device ${deviceId} closed from the Device panel; it had nothing running to power off`, { source: 'devices', event: 'device.closed', threadId: params.threadId, data: { deviceId } });
      this.#emulators.get(deviceId)?.kill();
      this.#live?.stop(deviceId, 'the device was powered off');
      for (const [threadId, open] of this.#sessions) if (open.delete(deviceId)) this.#changed(threadId);
      this.#forget(deviceId);
      return { closed: [deviceId] };
    }
    this.#core.logs.info(`Device ${deviceId} closed in the Device panel`, { source: 'devices', event: 'device.closed', threadId: params.threadId, data: { deviceId } });
    this.#sessions.get(params.threadId)?.delete(deviceId);
    this.#changed(params.threadId);
    if (![...this.#sessions.values()].some((open) => open.has(deviceId))) {
      this.#captures.delete(deviceId);
      this.#frames.delete(deviceId);
      this.#live?.stop(deviceId, 'closed in the last Device panel showing it');
    }
    return { closed: [deviceId] };
  }

  /** A conversation archived or removed keeps no device open; the device itself keeps running. */
  release(threadId: ThreadId): void {
    const open = this.#sessions.get(threadId);
    if (!open || !this.#sessions.delete(threadId)) return;
    this.#changed(threadId);
    for (const deviceId of open.keys()) {
      if (![...this.#sessions.values()].some((other) => other.has(deviceId))) this.#live?.stop(deviceId, 'its last conversation was archived');
    }
  }

  stop(): void {
    this.#closed = true;
    this.#live?.stopAll('the core is stopping');
    this.#offSettings?.();
    this.#sessions.clear();
    this.#captures.clear();
    this.#frames.clear();
  }

  // --- discovery ---

  async #discover(): Promise<{ host: { id: string; name: string; platforms: MobileHostPlatform[] }; devices: Located[] }> {
    const sdk = this.#sdk();
    const android = findAndroidSdk(sdk);
    const ios = findXcrun(sdk);
    const [androidDevices, iosDevices] = await Promise.all([
      android.tools ? this.#androidDevices(android.tools) : Promise.resolve([]),
      ios.xcrun ? this.#iosDevices(ios.xcrun) : Promise.resolve([]),
    ]);
    const booting = (device: Located): Located => (this.#boots.has(device.id) && device.state !== 'running' ? { ...device, state: 'booting' } : device);
    return {
      host: { id: LOCAL_DEVICE_HOST, name: machineName(), platforms: [android.status, ios.status] },
      devices: [...androidDevices, ...iosDevices].map(booting),
    };
  }

  async #androidDevices(tools: AndroidTools): Promise<Located[]> {
    const [attached, avds] = await Promise.all([
      this.#run(tools.adb, ['devices', '-l'], COMMAND_TIMEOUT_MS),
      tools.emulator ? this.#run(tools.emulator, ['-list-avds'], COMMAND_TIMEOUT_MS) : Promise.resolve(undefined),
    ]);
    const online = parseAdbDevices(text(attached.stdout)).filter((device) => device.state === 'device');
    const devices: Located[] = [];
    const running = new Set<string>();
    await Promise.all(online.map(async (device) => {
      if (device.serial.startsWith('emulator-')) {
        const avd = parseAvdName(text((await this.#run(tools.adb, ['-s', device.serial, 'emu', 'avd', 'name'], COMMAND_TIMEOUT_MS)).stdout));
        if (avd) {
          running.add(avd);
          devices.push({ id: avd, hostId: LOCAL_DEVICE_HOST, platform: 'android', name: avdLabel(avd), kind: 'emulator', state: 'running', serial: device.serial });
          return;
        }
      }
      if (mobileDeviceIdError(device.serial)) return;
      const name = device.model ? device.model.replace(/_/g, ' ') : device.serial;
      const kind = device.serial.startsWith('emulator-') ? 'emulator' : 'physical';
      devices.push({ id: device.serial, hostId: LOCAL_DEVICE_HOST, platform: 'android', name, kind, state: 'running', serial: device.serial });
    }));
    for (const avd of avds ? parseAvdList(text(avds.stdout)) : []) {
      if (!running.has(avd)) devices.push({ id: avd, hostId: LOCAL_DEVICE_HOST, platform: 'android', name: avdLabel(avd), kind: 'emulator', state: 'stopped' });
    }
    return devices.sort((a, b) => a.name.localeCompare(b.name));
  }

  async #iosDevices(xcrun: string): Promise<Located[]> {
    const run = await this.#run(xcrun, ['simctl', 'list', 'devices', '-j'], COMMAND_TIMEOUT_MS);
    return parseSimctlList(text(run.stdout), LOCAL_DEVICE_HOST).map((device) => ({ ...device, serial: device.id }));
  }

  #choose(platforms: MobileHostPlatform[], devices: Located[], params: RpcParams<'devices.open'>): Located {
    const candidates = devices.filter((device) => !params.platform || device.platform === params.platform);
    if (params.deviceId !== undefined) {
      const found = candidates.find((device) => device.id === params.deviceId);
      if (found) return found;
      throw refused(`no device ${params.deviceId} on this machine; \`boite device list\` names the ones it has`, { deviceId: params.deviceId });
    }
    const running = candidates.filter((device) => device.state === 'running');
    if (running.length === 1) return running[0]!;
    if (running.length === 0 && candidates.length === 1) return candidates[0]!;
    if (candidates.length === 0) {
      const reasons = platforms.filter((p) => (!params.platform || p.platform === params.platform) && p.reason).map((p) => p.reason);
      throw refused(reasons.length > 0 ? reasons.join(' ') : 'No simulators or emulators were found on this machine.', { platform: params.platform });
    }
    const ids = (running.length > 1 ? running : candidates).map((device) => device.id).join(', ');
    throw refused(`several devices are available; name one: ${ids}`, { platform: params.platform });
  }

  // --- boot ---

  #boot(device: Located): Boot {
    const pending = this.#boots.get(device.id);
    if (pending) return pending;
    const boot = { device, life: this.#lives.get(device.id) ?? 0, serial: device.serial } as Boot;
    boot.promise = (device.platform === 'android' ? this.#bootAndroid(boot) : this.#bootIos(device)).finally(() => {
      if (this.#boots.get(device.id) === boot) this.#boots.delete(device.id);
    });
    this.#boots.set(device.id, boot);
    return boot;
  }

  #alive(boot: Boot): boolean {
    return (this.#lives.get(boot.device.id) ?? 0) === boot.life;
  }

  async #bootAndroid(boot: Boot): Promise<Located> {
    const { device } = boot;
    const tools = this.#adb();
    const deadline = Date.now() + this.#bootTimeoutMs;
    let serial = device.serial;
    let exited: string | undefined;
    if (!serial) {
      if (!tools.emulator) throw refused(findAndroidSdk(this.#sdk()).status.reason ?? 'Android Emulator is missing from the SDK.');
      const child = this.#core.procs.spawn(SCOPE, tools.emulator, ['-avd', device.id, '-no-boot-anim'], { agentRoot: false });
      // The emulator logs for as long as it runs; reading keeps its pipes from filling.
      let tail = '';
      void new Response(child.proc.stdout).text().catch(() => '');
      void new Response(child.proc.stderr).text().then((err) => { tail = err.trim().slice(-400); }, () => undefined);
      const handle = { kill: () => child.proc.kill() };
      void child.exited.then((code) => {
        exited = `the emulator exited with code ${code}${tail ? `: ${tail}` : ''}`;
        if (this.#emulators.get(device.id) === handle) this.#emulators.delete(device.id);
      });
      this.#emulators.set(device.id, handle);
    }
    while (Date.now() < deadline) {
      if (this.#closed) throw refused('the core is shutting down');
      if (!this.#alive(boot)) throw refused(`${device.name} was powered off while starting`, { deviceId: device.id });
      if (exited && !serial) throw refused(exited);
      if (!serial) boot.serial = serial = await this.#emulatorSerial(tools.adb, device.id);
      if (serial) {
        const prop = await this.#run(tools.adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], COMMAND_TIMEOUT_MS);
        if (text(prop.stdout).trim() === '1') return { ...device, serial, state: 'running' };
      }
      await Bun.sleep(this.#pollMs);
    }
    if (this.#alive(boot)) this.#emulators.get(device.id)?.kill();
    throw refused(`${device.name} did not finish booting within ${Math.round(this.#bootTimeoutMs / 1000)} seconds`, { deviceId: device.id });
  }

  async #emulatorSerial(adb: string, avd: string): Promise<string | undefined> {
    const attached = parseAdbDevices(text((await this.#run(adb, ['devices'], COMMAND_TIMEOUT_MS)).stdout));
    for (const device of attached) {
      if (!device.serial.startsWith('emulator-') || device.state !== 'device') continue;
      const name = parseAvdName(text((await this.#run(adb, ['-s', device.serial, 'emu', 'avd', 'name'], COMMAND_TIMEOUT_MS)).stdout));
      if (name === avd) return device.serial;
    }
    return undefined;
  }

  async #bootIos(device: Located): Promise<Located> {
    const xcrun = this.#xcrun();
    if (device.state !== 'running') {
      const boot = await this.#run(xcrun, ['simctl', 'boot', device.id], COMMAND_TIMEOUT_MS);
      // Booting a simulator that is already up is an error simctl prints and the panel ignores.
      if (boot.code !== 0 && !/current state: Booted/i.test(boot.stderr)) throw refused(`xcrun simctl boot failed: ${this.#why(boot)}`, { deviceId: device.id });
    }
    const status = await this.#run(xcrun, ['simctl', 'bootstatus', device.id], this.#bootTimeoutMs);
    if (status.timedOut) throw refused(`${device.name} did not finish booting within ${Math.round(this.#bootTimeoutMs / 1000)} seconds`, { deviceId: device.id });
    if (status.code !== 0) throw refused(`xcrun simctl bootstatus failed: ${this.#why(status)}`, { deviceId: device.id });
    return { ...device, serial: device.id, state: 'running' };
  }

  async #shutdown(target: Located): Promise<void> {
    const booting = this.#boots.has(target.id);
    const run = target.platform === 'android'
      ? await this.#run(this.#adb().adb, ['-s', target.serial!, 'emu', 'kill'], COMMAND_TIMEOUT_MS)
      : await this.#run(this.#xcrun(), ['simctl', 'shutdown', target.id], COMMAND_TIMEOUT_MS);
    // A simulator someone already shut down is the state asked for; simctl still answers with an error.
    // Not while a boot was or is pending: `simctl boot` could start it after that answer.
    if (target.platform === 'ios' && run.code !== 0 && !booting && !this.#boots.has(target.id) && /Unable to shutdown device in current state: Shutdown/i.test(run.stderr)) return;
    if (run.code !== 0) throw refused(`powering ${target.name} off failed: ${this.#why(run)}`, { deviceId: target.id });
  }

  // --- screen ---

  #capture(target: Located): Capture['png'] {
    const cached = this.#captures.get(target.id);
    if (cached && Date.now() - cached.at < CAPTURE_REUSE_MS) return cached.png;
    const png = (async () => {
      const run = target.platform === 'android'
        ? await this.#run(this.#adb().adb, ['-s', target.serial!, 'exec-out', 'screencap', '-p'], COMMAND_TIMEOUT_MS)
        : await this.#simctlScreenshot(target);
      const size = run.code === 0 ? pngSize(run.stdout) : undefined;
      if (!size) throw refused(`the screen of ${target.name} could not be captured: ${this.#why(run) || 'not a PNG'}`, { deviceId: target.id });
      return { bytes: run.stdout, ...size, hash: new Bun.CryptoHasher('sha1').update(run.stdout).digest('hex') };
    })();
    const capture = { at: Date.now(), png };
    this.#captures.set(target.id, capture);
    png.catch(() => { if (this.#captures.get(target.id) === capture) this.#captures.delete(target.id); });
    return png;
  }

  /** Since Xcode 27, `screenshot -` writes a file named `-` instead of stdout: simctl writes to a private folder, removed once read. */
  async #simctlScreenshot(target: Located): Promise<CommandRun> {
    const xcrun = this.#xcrun();
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'boite-simctl-'));
      const file = join(directory, 'screen.png');
      const run = await this.#run(xcrun, ['simctl', 'io', target.id, 'screenshot', '--type=png', file], COMMAND_TIMEOUT_MS);
      return run.code === 0 ? { ...run, stdout: await readFile(file) } : run;
    } catch (error) {
      return { code: null, stdout: new Uint8Array(), stderr: error instanceof Error ? error.message : String(error), timedOut: false };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  #inputArgs(target: Located, input: MobileDeviceInput): string[] {
    switch (input.kind) {
      case 'tap': return ['shell', 'input', 'tap', String(input.x), String(input.y)];
      case 'swipe': return ['shell', 'input', 'swipe', String(input.from.x), String(input.from.y), String(input.to.x), String(input.to.y), String(input.durationMs ?? 300)];
      case 'text': return ['shell', 'input', 'text', adbText(input.text)];
      case 'key':
        if (input.key !== 'rotate') return ['shell', 'input', 'keyevent', String(ANDROID_KEYCODES[input.key])];
        if (target.kind !== 'emulator') throw refused('without the live stream, only an emulator rotates from the panel', { deviceId: target.id });
        return ['emu', 'rotate'];
      default: throw refused(`${input.kind} needs the device's live stream`, { deviceId: target.id });
    }
  }

  // --- live stream ---

  #streaming(): boolean {
    return this.#core.settings.get().deviceStream === true;
  }

  #loadStreams(): Promise<DeviceStreams> {
    this.#streams ??= import('./stream.ts').then(({ DeviceStreams }) => {
      const streams = new DeviceStreams({
        dataDir: this.#core.dataDir,
        adb: async (serial, args, timeoutMs) => {
          const run = await this.#run(this.#adb().adb, ['-s', serial, ...args], timeoutMs);
          return { ok: run.code === 0, output: run.timedOut ? 'timed out' : `${text(run.stdout)}\n${run.stderr}`.trim().slice(-2000) };
        },
        spawnAdb: (serial, args) => this.#core.procs.spawn(SCOPE, this.#adb().adb, ['-s', serial, ...args], { agentRoot: false }),
        log: (level, message, event, data) => this.#core.logs[level](message, { source: 'devices', event, data }),
      }, this.#streamOptions);
      this.#live = streams;
      this.#offSettings = this.#core.bus.onCommitted((name, payload) => {
        if (name === 'settings.updated' && (payload as Settings).deviceStream !== true) streams.stopAll('the live stream was turned off in Settings');
      });
      return streams;
    });
    return this.#streams;
  }

  // --- sessions ---

  #list(threadId: ThreadId): MobileDeviceSession[] {
    return [...(this.#sessions.get(threadId)?.values() ?? [])].map((session) => ({ ...session }));
  }

  #settle(deviceId: string, change: Pick<MobileDeviceSession, 'state' | 'error'>): void {
    for (const [threadId, open] of this.#sessions) {
      const session = open.get(deviceId);
      if (!session || session.state !== 'booting') continue;
      session.state = change.state;
      if (change.error) session.error = change.error.slice(0, 600);
      else delete session.error;
      this.#changed(threadId);
    }
  }

  #forget(deviceId: string): void {
    this.#targets.delete(deviceId);
    this.#captures.delete(deviceId);
    this.#frames.delete(deviceId);
    this.#emulators.delete(deviceId);
  }

  #changed(threadId: ThreadId): void {
    if (this.#closed) return;
    this.#core.bus.emit('devices.changed', { threadId, sessions: this.#list(threadId) });
  }

  #ready(threadId: ThreadId, deviceId: string, connection?: Connection): Located {
    this.#thread(threadId, connection);
    const problem = mobileDeviceIdError(deviceId);
    if (problem) throw refused(problem, { deviceId });
    const session = this.#sessions.get(threadId)?.get(deviceId);
    if (!session) throw refused(`${deviceId} is not open in this conversation; open it first`, { deviceId });
    if (session.state === 'booting') throw refused(`${session.name} is still starting`, { deviceId });
    if (session.state === 'failed') throw refused(session.error ?? `${session.name} failed to start`, { deviceId });
    const target = this.#targets.get(deviceId);
    if (!target) throw refused(`${session.name} is not running`, { deviceId });
    return target;
  }

  /** The device named, or the conversation's only open one. */
  #only(threadId: ThreadId, deviceId: string | undefined, connection?: Connection): string {
    this.#thread(threadId, connection);
    if (deviceId !== undefined) {
      const problem = mobileDeviceIdError(deviceId);
      if (problem) throw refused(problem, { deviceId });
      if (!this.#sessions.get(threadId)?.has(deviceId)) throw refused(`${deviceId} is not open in this conversation`, { deviceId });
      return deviceId;
    }
    const open = [...(this.#sessions.get(threadId)?.keys() ?? [])];
    if (open.length === 1) return open[0]!;
    throw refused(open.length === 0 ? 'no device is open in this conversation' : `several devices are open; name one: ${open.join(', ')}`, { threadId });
  }

  #thread(threadId: ThreadId, connection?: Connection): void {
    const thread = this.#core.threads.require(threadId);
    if (thread.archived) throw refused('the Device panel needs an active conversation', { threadId });
    if (connection?.identity.principal === 'session' && !connection.subscriptions.has(threadId)) {
      throw refused('subscribe to the conversation before using its Device panel', { threadId });
    }
  }

  #host(hostId: string | undefined): void {
    if (hostId !== undefined && hostId !== LOCAL_DEVICE_HOST) throw refused(`unknown device host ${String(hostId).slice(0, 80)}; this machine's host is ${LOCAL_DEVICE_HOST}`, { hostId });
  }

  #id(deviceId: string): void {
    const problem = mobileDeviceIdError(deviceId);
    if (problem) throw refused(problem, { deviceId });
  }

  #adb(): AndroidTools {
    const android = findAndroidSdk(this.#sdk());
    if (!android.tools) throw refused(android.status.reason ?? 'Android SDK was not found.');
    return android.tools;
  }

  #xcrun(): string {
    const ios = findXcrun(this.#sdk());
    if (!ios.xcrun) throw refused(ios.status.reason ?? 'Xcode command line tools were not found.');
    return ios.xcrun;
  }

  #control(target: Located): string[] | undefined {
    if (target.platform === 'android') {
      const android = findAndroidSdk(this.#sdk());
      return android.tools && target.serial ? [android.tools.adb, '-s', target.serial] : undefined;
    }
    return ['xcrun', 'simctl'];
  }

  #why(run: CommandRun): string {
    if (run.timedOut) return 'timed out';
    return (run.stderr.trim() || text(run.stdout).trim()).slice(-400);
  }

  #run(command: string, args: string[], timeoutMs: number): Promise<CommandRun> {
    return runCommand(this.#core.procs, SCOPE, command, args, timeoutMs);
  }
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const avdLabel = (avd: string) => avd.replace(/_/g, ' ');
