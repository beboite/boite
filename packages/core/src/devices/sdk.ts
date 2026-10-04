/*
 * Where the Android SDK and Xcode live, and what their tools print. Pure
 * functions over an injected environment, so the tests run them against a
 * fake SDK on any machine.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { MobileDevice, MobileHostPlatform } from '@boite/contracts';

export interface SdkEnvironment {
  os: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}

export function currentSdkEnvironment(): SdkEnvironment {
  return { os: process.platform, env: process.env, home: homedir() };
}

export interface AndroidTools {
  root: string;
  adb: string;
  /** Absent when the SDK lacks the Emulator package: connected phones and running emulators still list. */
  emulator?: string;
}

export const NO_ANDROID_SDK = 'Android SDK was not found. Install it with Android Studio or set ANDROID_HOME to your SDK directory.';
export const IOS_NEEDS_MAC = 'iOS Simulators need macOS with Xcode.';
export const NO_XCODE = 'Xcode command line tools were not found.';

/** `Bun.which` over one folder honours PATHEXT, so `adb.exe` and a test's `adb.cmd` both resolve. */
const tool = (folder: string, name: string) => Bun.which(name, { PATH: folder }) ?? undefined;

/**
 * ANDROID_HOME, then ANDROID_SDK_ROOT, is the only place looked at when set.
 * Otherwise Android Studio's default folder for this OS, then the SDK around an
 * `adb` on PATH.
 */
export function findAndroidSdk(sdk: SdkEnvironment): { tools?: AndroidTools; status: MobileHostPlatform } {
  const configured = sdk.env.ANDROID_HOME || sdk.env.ANDROID_SDK_ROOT;
  const candidates: string[] = [];
  if (configured) candidates.push(configured);
  else {
    if (sdk.os === 'darwin') candidates.push(join(sdk.home, 'Library', 'Android', 'sdk'));
    else if (sdk.os === 'win32') candidates.push(join(sdk.env.LOCALAPPDATA ?? join(sdk.home, 'AppData', 'Local'), 'Android', 'Sdk'));
    else candidates.push(join(sdk.home, 'Android', 'Sdk'));
    const onPath = Bun.which('adb', { PATH: sdk.env.PATH ?? sdk.env.Path ?? '' });
    if (onPath) candidates.push(dirname(dirname(onPath)));
  }
  const root = candidates.find((candidate) => existsSync(candidate));
  if (!root) {
    const reason = configured ? `${NO_ANDROID_SDK} ${configured} does not exist.` : NO_ANDROID_SDK;
    return { status: { platform: 'android', available: false, reason } };
  }
  const adb = tool(join(root, 'platform-tools'), 'adb');
  if (!adb) return { status: { platform: 'android', available: false, reason: `Android SDK Platform-Tools are missing from ${root}.` } };
  const emulator = tool(join(root, 'emulator'), 'emulator');
  const tools: AndroidTools = emulator ? { root, adb, emulator } : { root, adb };
  return emulator
    ? { tools, status: { platform: 'android', available: true } }
    : { tools, status: { platform: 'android', available: true, reason: `Android Emulator is missing from ${root}; only connected phones and running emulators are listed.` } };
}

export function findXcrun(sdk: SdkEnvironment): { xcrun?: string; status: MobileHostPlatform } {
  if (sdk.os !== 'darwin') return { status: { platform: 'ios', available: false, reason: IOS_NEEDS_MAC } };
  const xcrun = Bun.which('xcrun', { PATH: sdk.env.PATH ?? '' });
  if (!xcrun) return { status: { platform: 'ios', available: false, reason: NO_XCODE } };
  return { xcrun, status: { platform: 'ios', available: true } };
}

export interface AdbDevice {
  serial: string;
  /** `device` when usable; `offline`, `unauthorized` or `authorizing` otherwise. */
  state: string;
  model?: string;
}

/** `adb devices -l`: a header, then `serial<TAB>state key:value...` per line. */
export function parseAdbDevices(output: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) continue;
    const [serial, state, ...details] = line.split(/\s+/);
    if (!serial || !state) continue;
    const model = details.find((detail) => detail.startsWith('model:'))?.slice('model:'.length);
    devices.push(model ? { serial, state, model } : { serial, state });
  }
  return devices;
}

/** `emulator -list-avds`: one name per line, among the log lines some versions print. */
export function parseAvdList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9._-]+$/.test(line));
}

/** `adb emu avd name`: the name, then `OK`. */
export function parseAvdName(output: string): string | undefined {
  const name = output.split(/\r?\n/).map((line) => line.trim()).find((line) => line && line !== 'OK');
  return name && /^[A-Za-z0-9._-]+$/.test(name) ? name : undefined;
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-18-2` reads `iOS 18.2`. */
export function runtimeName(runtime: string): string | undefined {
  const match = /SimRuntime\.([A-Za-z]+)-([\d-]+)$/.exec(runtime);
  return match ? `${match[1]} ${match[2]!.replace(/-/g, '.')}` : undefined;
}

/** `xcrun simctl list devices -j`: the available iPhone and iPad simulators. */
export function parseSimctlList(output: string, hostId: string): MobileDevice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  const runtimes = (parsed as { devices?: unknown } | null)?.devices;
  if (!runtimes || typeof runtimes !== 'object') return [];
  const devices: MobileDevice[] = [];
  for (const [runtime, list] of Object.entries(runtimes as Record<string, unknown>)) {
    if (!/SimRuntime\.iOS-/.test(runtime) || !Array.isArray(list)) continue;
    const named = runtimeName(runtime);
    for (const entry of list as { udid?: unknown; name?: unknown; state?: unknown; isAvailable?: unknown }[]) {
      if (typeof entry?.udid !== 'string' || typeof entry.name !== 'string' || entry.isAvailable === false) continue;
      const state = entry.state === 'Booted' ? 'running' : entry.state === 'Booting' ? 'booting' : 'stopped';
      devices.push({ id: entry.udid, hostId, platform: 'ios', name: entry.name, kind: 'simulator', state, ...(named ? { runtime: named } : {}) });
    }
  }
  return devices;
}

/** A PNG's own size, read from its header. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  return width > 0 && height > 0 && width <= 16384 && height <= 16384 ? { width, height } : undefined;
}

/** What `adb shell input text` types: the device's shell reads the quotes, `input` reads `%s` as a space. */
export function adbText(text: string): string {
  return `'${text.replace(/'/g, `'\\''`).replace(/ /g, '%s')}'`;
}
