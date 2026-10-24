/*
 * The Device panel's live stream: one scrcpy session per Android device,
 * shared by every viewer, started by the first `devices.stream` call and
 * stopped a few seconds after the last viewer goes. The core pushes the
 * vendored server with adb, starts it with app_process and accepts its video
 * and control sockets through `adb reverse`. control.ts loads this module on
 * the first stream. See docs/devices.md, "Live stream".
 */
/// <reference path="../text.d.ts" />
import type { LogData, MobileDeviceInput, MobileDeviceStream, MobileDeviceStreamChunk } from '@boite/contracts';
import { MOBILE_STREAM_SIZE } from '@boite/contracts';
import { mkdirSync, renameSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import serverJar from '../../vendor/scrcpy/scrcpy-server-v5.0.1.jar' with { type: 'file' };
import { refused } from '../errors.ts';
import type { SpawnedProcess } from '../procs.ts';
import { ANDROID_KEYCODES } from './sdk.ts';
import {
  CLIPBOARD_MAX_BYTES,
  DEVICE_SERVER_PATH,
  DeviceMessageReader,
  SCRCPY_SERVER,
  VideoReader,
  avcCodec,
  concat,
  getClipboardMessage,
  keycodeMessage,
  newScid,
  rotateMessage,
  scrollMessage,
  serverArgs,
  setClipboardMessage,
  socketName,
  textMessages,
  touchMessage,
  type VideoEvent,
  type VideoPoint,
} from './scrcpy.ts';

/** What the stream needs from the Device panel: adb through `procs`, the data folder and the log. */
export interface StreamHost {
  readonly dataDir: string;
  adb(serial: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }>;
  /** The long-lived `adb shell` that runs the server, a tool process of `system:devices`. */
  spawnAdb(serial: string, args: string[]): SpawnedProcess;
  log(level: 'info' | 'warn', message: string, event: string, data: LogData): void;
}

export interface StreamTarget {
  id: string;
  serial: string;
  name: string;
}

export interface StreamOptions {
  /** How long a viewer counts after its last call. */
  viewerMs?: number;
  /** How long a session outlives its last viewer, so a reload finds it running. */
  lingerMs?: number;
  /** The long poll's wait for new video. */
  waitMs?: number;
  /** How long a failure is answered before a viewer may start the device's stream again. */
  failureMs?: number;
}

/** The longest sides the session encodes: a viewer asking between two gets the larger. */
const SIZES = [480, 720, 1024, 1280, 1600, 1920, MOBILE_STREAM_SIZE.max];
const DEFAULT_SIZE = 1280;
const START_TIMEOUT_MS = 15_000;
const STARTING_WAIT_MS = 3000;
const REPLY_TIMEOUT_MS = 3000;
const LOST_GRACE_MS = 1000;
/** What a session keeps since its last key frame; past it, deltas wait for the next key frame. */
const BUFFER_MAX = 8 << 20;


interface Chunk {
  seq: number;
  key: boolean;
  pts: number;
  data: Uint8Array;
  base64?: string;
}

interface Viewer {
  seen: number;
  polls: number;
  size: number;
  off?: () => void;
}

interface Session {
  target: StreamTarget;
  scid: string;
  size: number;
  state: 'starting' | 'live';
  /** Names the encoder's current run: a new session packet (a rotation, a restart) is a new id. */
  run: string;
  codec?: string;
  config?: Uint8Array;
  video?: { width: number; height: number };
  /** The screen's natural size from `wm size`, oriented like the video when answered. */
  natural?: { width: number; height: number };
  chunks: Chunk[];
  bytes: number;
  seq: number;
  viewers: Map<string, Viewer>;
  emptySince?: number;
  waiters: Set<() => void>;
  clipboards: ((text: string) => void)[];
  acks: Map<number, (ok: boolean) => void>;
  sequence: number;
  child?: SpawnedProcess;
  listener?: Server;
  sockets: Socket[];
  control?: Socket;
  reversed: boolean;
  /** A socket closed; the session fails once the server's exit has had a moment to explain why. */
  lost?: boolean;
  stopped: boolean;
  tail: string;
}

export class DeviceStreams {
  readonly #host: StreamHost;
  readonly #viewerMs: number;
  readonly #lingerMs: number;
  readonly #waitMs: number;
  readonly #failureMs: number;
  readonly #sessions = new Map<string, Session>();
  readonly #failures = new Map<string, { at: number; reason: string }>();
  /** The vendored jar, checked and copied into the data directory on the first start. */
  #jar?: Promise<string>;
  #timer?: ReturnType<typeof setInterval>;

  constructor(host: StreamHost, options: StreamOptions = {}) {
    this.#host = host;
    this.#viewerMs = options.viewerMs ?? 5000;
    this.#lingerMs = options.lingerMs ?? 3000;
    this.#waitMs = options.waitMs ?? 1000;
    this.#failureMs = options.failureMs ?? 15_000;
  }

  /** The long poll behind `devices.stream`. `viewer` names the caller's connection; `onClose` ends its viewing early. */
  async stream(target: StreamTarget, viewer: string, params: { maxSize?: number; after?: { id: string; seq: number } }, onClose?: (callback: () => void) => () => void): Promise<MobileDeviceStream> {
    const size = bucket(params.maxSize ?? DEFAULT_SIZE);
    let session = this.#sessions.get(target.id);
    if (!session) {
      const failure = this.#failures.get(target.id);
      if (failure && Date.now() - failure.at < this.#failureMs) return { deviceId: target.id, state: 'failed', reason: failure.reason, chunks: [] };
      this.#failures.delete(target.id);
      session = this.#start(target, size, new Map());
    } else if (session.state === 'live' && size > session.size) {
      // A larger panel restarts the encoder at its size; the viewers already there carry over.
      this.#log('info', `Restarting the live stream of ${target.name} at ${size} pixels for a larger panel`, 'device.stream-resized', { deviceId: target.id, size });
      this.#teardown(session, true);
      session = this.#start(target, size, session.viewers);
    }
    const seen = this.#viewer(session, viewer, size, onClose);
    seen.polls++;
    try {
      if (session.state === 'starting') await this.#wait(session, STARTING_WAIT_MS, () => session!.state !== 'starting');
      else if (params.after?.id === session.run && !session.chunks.some((chunk) => chunk.seq > params.after!.seq)) {
        await this.#wait(session, this.#waitMs, () => session!.run !== params.after!.id || session!.chunks.some((chunk) => chunk.seq > params.after!.seq));
      }
      return this.#answer(target.id, session, params.after);
    } finally {
      seen.polls--;
      seen.seen = Date.now();
    }
  }

  /** Whether input to this device goes through its control socket. */
  live(deviceId: string): boolean {
    const session = this.#sessions.get(deviceId);
    // A rotation restarts the encoder; the control socket and the screen's size stay good meanwhile.
    return session !== undefined && !session.stopped && !session.lost && session.control !== undefined && session.video !== undefined && session.natural !== undefined;
  }

  /** Sends one input through the device's session; the caller checked `live` and the input's shape. */
  async input(deviceId: string, input: MobileDeviceInput): Promise<void> {
    const session = this.#live(deviceId);
    switch (input.kind) {
      case 'tap': {
        const at = this.#point(session, input);
        this.#send(session, touchMessage('down', 0, at), touchMessage('up', 0, at));
        return;
      }
      case 'swipe': {
        const duration = input.durationMs ?? 300;
        const steps = Math.max(2, Math.round(duration / 16));
        this.#send(session, touchMessage('down', 0, this.#point(session, input.from)));
        for (let i = 1; i < steps; i++) {
          await Bun.sleep(duration / steps);
          const t = i / steps;
          this.#send(session, touchMessage('move', 0, this.#point(session, { x: input.from.x + (input.to.x - input.from.x) * t, y: input.from.y + (input.to.y - input.from.y) * t })));
        }
        await Bun.sleep(duration / steps);
        this.#send(session, touchMessage('up', 0, this.#point(session, input.to)));
        return;
      }
      case 'touch':
        this.#send(session, touchMessage(input.action, input.pointerId ?? 0, this.#point(session, input)));
        return;
      case 'scroll':
        this.#send(session, scrollMessage(this.#point(session, input), input.dx, input.dy));
        return;
      case 'key':
        this.#send(session, ...(input.key === 'rotate' ? [rotateMessage()] : keycodeMessage(ANDROID_KEYCODES[input.key])));
        return;
      case 'text':
        // The server types only what its virtual keyboard maps; anything else is pasted through the clipboard.
        if (/^[\x20-\x7e]+$/.test(input.text)) this.#send(session, ...textMessages(input.text));
        else await this.#setClipboard(session, input.text, true);
        return;
      case 'clipboard':
        await this.#setClipboard(session, input.text, input.paste === true);
        return;
    }
  }

  /** The device's clipboard, after it copies or cuts its selection when asked. Empty when it holds no text. */
  async clipboard(deviceId: string, copy?: 'copy' | 'cut'): Promise<string> {
    const session = this.#live(deviceId);
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        const at = session.clipboards.indexOf(done);
        if (at >= 0) session.clipboards.splice(at, 1);
        resolve('');
      }, REPLY_TIMEOUT_MS);
      const done = (text: string) => { clearTimeout(timer); resolve(text); };
      session.clipboards.push(done);
      try {
        this.#send(session, getClipboardMessage(copy));
      } catch (error) {
        // A waiter left behind would take the next caller's reply.
        session.clipboards.splice(session.clipboards.indexOf(done), 1);
        clearTimeout(timer);
        throw error;
      }
    });
  }

  /** Ends the device's session now: closed in the last panel, unplugged, powered off. The next panel tries again. */
  stop(deviceId: string, why: string): void {
    this.#failures.delete(deviceId);
    const session = this.#sessions.get(deviceId);
    if (!session) return;
    this.#log('info', `Live stream of ${session.target.name} stopped: ${why}`, 'device.stream-stopped', { deviceId, why });
    this.#teardown(session);
  }

  stopAll(why: string): void {
    for (const deviceId of [...this.#sessions.keys()]) this.stop(deviceId, why);
    this.#failures.clear();
  }

  // --- session ---

  #start(target: StreamTarget, size: number, viewers: Map<string, Viewer>): Session {
    const session: Session = {
      target, scid: newScid(), size, state: 'starting', run: '', chunks: [], bytes: 0, seq: 0, viewers, waiters: new Set(),
      clipboards: [], acks: new Map(), sequence: 0, sockets: [], reversed: false, stopped: false, tail: '',
    };
    this.#sessions.set(target.id, session);
    this.#tick();
    void this.#launch(session).catch((error: unknown) => this.#fail(session, error instanceof Error ? error.message : String(error)));
    return session;
  }

  async #launch(session: Session): Promise<void> {
    const { target } = session;
    const started = Date.now();
    const bitRate = session.size <= 720 ? 1_500_000 : session.size <= 1280 ? 3_000_000 : 5_000_000;
    this.#log('info', `Starting the live stream of ${target.name} at ${session.size} pixels, ${bitRate / 1e6} Mbit/s`, 'device.stream-starting', { deviceId: target.id, size: session.size, bitRate });
    const jar = await this.#serverJar();
    // The server deletes its own jar once it runs (`cleanup=true`), so every start pushes it again, as scrcpy's client does.
    const push = await this.#host.adb(target.serial, ['push', jar, DEVICE_SERVER_PATH], 60_000);
    if (!push.ok) throw new Error(`adb push of the scrcpy server failed: ${push.output}`);
    if (session.stopped) return;
    const wm = await this.#host.adb(target.serial, ['shell', 'wm', 'size'], 15_000);
    if (session.stopped) return;
    session.natural = wmSize(wm.output);
    if (!session.natural) throw new Error(`adb shell wm size gave no screen size: ${wm.output.slice(0, 200)}`);
    const listener = session.listener = createServer();
    const accepted: Socket[] = [];
    const both = new Promise<void>((resolve, reject) => {
      listener.on('connection', (socket) => {
        socket.setNoDelay(true);
        session.sockets.push(socket);
        accepted.push(socket);
        if (accepted.length === 2) resolve();
      });
      listener.on('error', reject);
    });
    // A listen that fails throws below, before anything awaits `both`.
    both.catch(() => {});
    const port = await new Promise<number>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => resolve((listener.address() as { port: number }).port));
    });
    if (session.stopped) { listener.close(); return; }
    const reverse = await this.#host.adb(target.serial, ['reverse', socketName(session.scid), `tcp:${port}`], 15_000);
    if (!reverse.ok) throw new Error(`adb reverse failed: ${reverse.output}`);
    session.reversed = true;
    if (session.stopped) {
      void this.#host.adb(target.serial, ['reverse', '--remove', socketName(session.scid)], 15_000);
      return;
    }
    const child = session.child = this.#host.spawnAdb(target.serial, serverArgs({ scid: session.scid, maxSize: session.size, bitRate }));
    const keep = (text: string) => { session.tail = (session.tail + text).slice(-600); };
    void drain(child.proc.stdout, keep);
    void drain(child.proc.stderr, keep);
    void child.exited.then((code) => this.#fail(session, `the scrcpy server exited with code ${code}${session.tail.trim() ? `: ${session.tail.trim().split('\n').slice(-3).join(' ')}` : ''}`));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([both, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${target.name} did not connect its video within ${START_TIMEOUT_MS / 1000} seconds`)), START_TIMEOUT_MS); })])
      .finally(() => clearTimeout(timer));
    if (session.stopped) return;
    // The device connects video first, then control. Neither the tunnel nor the port takes anyone else.
    listener.close();
    session.reversed = false;
    void this.#host.adb(target.serial, ['reverse', '--remove', socketName(session.scid)], 15_000);
    const [video, control] = accepted as [Socket, Socket];
    session.control = control;
    const reader = new VideoReader();
    video.on('data', (bytes: Buffer) => {
      try {
        for (const event of reader.push(new Uint8Array(bytes))) this.#video(session, event);
      } catch (error) {
        this.#fail(session, error instanceof Error ? error.message : String(error));
      }
    });
    const messages = new DeviceMessageReader();
    control.on('data', (bytes: Buffer) => {
      try {
        for (const message of messages.push(new Uint8Array(bytes))) {
          if (message.type === 'clipboard') session.clipboards.shift()?.(message.text);
          else { session.acks.get(message.sequence)?.(true); session.acks.delete(message.sequence); }
        }
      } catch (error) {
        this.#fail(session, error instanceof Error ? error.message : String(error));
      }
    });
    // An unplugged device drops the sockets before adb reports the server's exit, whose message says more.
    const lost = (reason: string) => {
      if (session.lost) return;
      session.lost = true;
      setTimeout(() => this.#fail(session, reason), LOST_GRACE_MS).unref?.();
    };
    for (const socket of [video, control]) {
      socket.on('error', (error) => lost(`the stream's connection failed: ${error.message}`));
      socket.on('close', () => lost(`${target.name} stopped streaming`));
    }
    this.#log('info', `Live stream of ${target.name} connected in ${Date.now() - started} ms`, 'device.stream-connected', { deviceId: target.id, ms: Date.now() - started });
  }

  #video(session: Session, event: VideoEvent): void {
    if (event.type === 'session') {
      session.video = { width: event.width, height: event.height };
      session.run = crypto.randomUUID().slice(0, 8);
      session.chunks = [];
      session.bytes = 0;
      // A new encoder (a rotation) sends its own SPS and PPS before its first key frame.
      session.config = undefined;
      session.codec = undefined;
      session.state = 'starting';
      return this.#notify(session);
    }
    if (event.config) {
      session.config = event.data;
      session.codec = avcCodec(event.data) ?? session.codec;
      return;
    }
    if (event.key) {
      // Every key frame carries the SPS and PPS, so a viewer starts from any of them.
      const data = session.config ? concat(session.config, event.data) : event.data;
      session.chunks = [{ seq: ++session.seq, key: true, pts: event.pts, data }];
      session.bytes = data.length;
      if (session.codec && session.video) session.state = 'live';
    } else {
      if (session.chunks.length === 0 || session.bytes + event.data.length > BUFFER_MAX) return;
      session.chunks.push({ seq: ++session.seq, key: false, pts: event.pts, data: event.data });
      session.bytes += event.data.length;
    }
    this.#notify(session);
  }

  #answer(deviceId: string, session: Session, after: { id: string; seq: number } | undefined): MobileDeviceStream {
    if (this.#sessions.get(deviceId) !== session) {
      // A larger panel restarted the encoder while this call waited: answer from the new run.
      const current = this.#sessions.get(deviceId);
      if (current) return this.#answer(deviceId, current, after);
      const failure = this.#failures.get(deviceId);
      return failure ? { deviceId, state: 'failed', reason: failure.reason, chunks: [] } : { deviceId, state: 'off', reason: 'the live stream stopped', chunks: [] };
    }
    if (session.state !== 'live' || !session.video || !session.natural) return { deviceId, state: 'starting', chunks: [] };
    const fresh = after?.id === session.run ? session.chunks.filter((chunk) => chunk.seq > after.seq) : session.chunks;
    return {
      deviceId,
      state: 'live',
      id: session.run,
      codec: session.codec,
      width: session.video.width,
      height: session.video.height,
      screen: oriented(session.natural, session.video),
      chunks: fresh.map(wire),
    };
  }

  #fail(session: Session, reason: string): void {
    if (session.stopped) return;
    this.#log('warn', `Live stream of ${session.target.name} failed: ${reason}`, 'device.stream-failed', { deviceId: session.target.id, reason: reason.slice(0, 400) });
    this.#failures.set(session.target.id, { at: Date.now(), reason: reason.slice(0, 600) });
    this.#teardown(session);
  }

  /** Closes the sockets (the server stops and restores the device), removes the tunnel and ends the adb process it ran in. */
  #teardown(session: Session, keepViewers = false): void {
    if (session.stopped) return;
    session.stopped = true;
    if (this.#sessions.get(session.target.id) === session) this.#sessions.delete(session.target.id);
    for (const socket of session.sockets) socket.destroy();
    session.listener?.close();
    if (session.reversed) void this.#host.adb(session.target.serial, ['reverse', '--remove', socketName(session.scid)], 15_000);
    const child = session.child;
    if (child) {
      // The server exits once its sockets close; the adb process that ran it gets a moment, then its own PID is ended.
      const timer = setTimeout(() => child.proc.kill(), 1000);
      void child.exited.finally(() => clearTimeout(timer));
    }
    for (const done of session.clipboards.splice(0)) done('');
    // Text not yet confirmed never reached the device.
    for (const ack of session.acks.values()) ack(false);
    session.acks.clear();
    this.#notify(session);
    if (!keepViewers) for (const viewer of session.viewers.values()) viewer.off?.();
    if (this.#sessions.size === 0 && this.#timer) { clearInterval(this.#timer); this.#timer = undefined; }
  }

  // --- viewers ---

  #viewer(session: Session, key: string, size: number, onClose?: (callback: () => void) => () => void): Viewer {
    let viewer = session.viewers.get(key);
    if (!viewer) {
      viewer = { seen: Date.now(), polls: 0, size };
      session.viewers.set(key, viewer);
      const deviceId = session.target.id;
      viewer.off = onClose?.(() => { this.#sessions.get(deviceId)?.viewers.delete(key); });
    }
    viewer.size = size;
    delete session.emptySince;
    return viewer;
  }

  #tick(): void {
    this.#timer ??= setInterval(() => {
      const now = Date.now();
      for (const session of [...this.#sessions.values()]) {
        for (const [key, viewer] of session.viewers) {
          if (viewer.polls === 0 && now - viewer.seen > this.#viewerMs) { viewer.off?.(); session.viewers.delete(key); }
        }
        if (session.viewers.size > 0) { delete session.emptySince; continue; }
        session.emptySince ??= now;
        if (now - session.emptySince >= this.#lingerMs) this.stop(session.target.id, 'no viewer remains');
      }
    }, Math.min(1000, Math.max(50, this.#lingerMs / 2)));
  }

  // --- input ---

  #live(deviceId: string): Session {
    const session = this.#sessions.get(deviceId);
    if (!session || !this.live(deviceId)) throw refused('the live stream of this device is not running', { deviceId });
    return session;
  }

  /** Screen pixels, as a screenshot has them, to the video's pixels the server expects. */
  #point(session: Session, at: { x: number; y: number }): VideoPoint {
    const video = session.video!;
    const screen = oriented(session.natural!, video);
    return {
      x: clamp(Math.round((at.x * video.width) / screen.width), video.width - 1),
      y: clamp(Math.round((at.y * video.height) / screen.height), video.height - 1),
      width: video.width,
      height: video.height,
    };
  }

  #send(session: Session, ...messages: Uint8Array[]): void {
    const control = session.control;
    if (!control || control.destroyed || session.stopped) throw refused(`the live stream of ${session.target.name} ended`, { deviceId: session.target.id });
    for (const message of messages) control.write(message);
  }

  async #setClipboard(session: Session, text: string, paste: boolean): Promise<void> {
    if (new TextEncoder().encode(text).length > CLIPBOARD_MAX_BYTES) throw refused(`device clipboard text must be at most ${CLIPBOARD_MAX_BYTES} UTF-8 bytes`, { deviceId: session.target.id });
    const sequence = ++session.sequence;
    const acked = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { session.acks.delete(sequence); resolve(false); }, REPLY_TIMEOUT_MS);
      session.acks.set(sequence, (ok) => { clearTimeout(timer); resolve(ok); });
    });
    try {
      this.#send(session, setClipboardMessage(sequence, text, paste));
    } catch (error) {
      session.acks.get(sequence)?.(false);
      session.acks.delete(sequence);
      throw error;
    }
    if (!(await acked)) throw refused(session.stopped ? `the live stream of ${session.target.name} ended before its clipboard was set` : `${session.target.name} did not confirm its clipboard`, { deviceId: session.target.id });
  }

  // --- helpers ---

  #wait(session: Session, ms: number, done: () => boolean): Promise<void> {
    if (done() || session.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const check = () => {
        if (!done() && !session.stopped) return;
        finish();
      };
      const finish = () => { clearTimeout(timer); session.waiters.delete(check); resolve(); };
      const timer = setTimeout(finish, ms);
      session.waiters.add(check);
    });
  }

  #notify(session: Session): void {
    for (const check of [...session.waiters]) check();
  }

  /** The vendored server, copied once into the data folder: a compiled core holds it inside its executable, where adb cannot read. */
  #serverJar(): Promise<string> {
    this.#jar ??= (async () => {
      const dest = join(this.#host.dataDir, 'scrcpy', SCRCPY_SERVER.name);
      const existing = Bun.file(dest);
      if (await existing.exists() && existing.size === SCRCPY_SERVER.size && sha256(await existing.bytes()) === SCRCPY_SERVER.sha256) return dest;
      const source = isAbsolute(serverJar) ? serverJar : join(import.meta.dir, serverJar);
      const bytes = await Bun.file(source).bytes();
      if (bytes.length !== SCRCPY_SERVER.size || sha256(bytes) !== SCRCPY_SERVER.sha256) throw new Error(`the bundled scrcpy server ${SCRCPY_SERVER.name} does not match its recorded SHA-256`);
      mkdirSync(dirname(dest), { recursive: true });
      await Bun.write(`${dest}.part`, bytes);
      renameSync(`${dest}.part`, dest);
      return dest;
    })();
    this.#jar.catch(() => { this.#jar = undefined; });
    return this.#jar;
  }

  #log(level: 'info' | 'warn', message: string, event: string, data: LogData): void {
    this.#host.log(level, message, event, data);
  }
}

/** `wm size` prints the physical size and, when one is set, the override the screen really uses. */
export function wmSize(output: string): { width: number; height: number } | undefined {
  const read = (label: string) => {
    const match = new RegExp(`${label} size:\\s*(\\d+)x(\\d+)`).exec(output);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined;
  };
  return read('Override') ?? read('Physical');
}

function oriented(natural: { width: number; height: number }, video: { width: number; height: number }) {
  return (natural.width > natural.height) === (video.width > video.height) ? natural : { width: natural.height, height: natural.width };
}

function wire(chunk: Chunk): MobileDeviceStreamChunk {
  chunk.base64 ??= Buffer.from(chunk.data).toString('base64');
  return { seq: chunk.seq, key: chunk.key, pts: chunk.pts, base64: chunk.base64 };
}

const bucket = (size: number) => SIZES.find((one) => one >= size) ?? MOBILE_STREAM_SIZE.max;
const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

async function drain(stream: ReadableStream<Uint8Array>, keep: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  try {
    for await (const bytes of stream) keep(decoder.decode(bytes, { stream: true }));
  } catch {
    // The process ended; what it printed is already kept.
  }
}
