/**
 * The audio sessions of the default render endpoint, read through Core Audio
 * over `bun:ffi`. Windows only.
 *
 * There is no COM object to implement here, only COM objects to call: the
 * session notifications an audio engine pushes would need an MTA thread and a
 * JS vtable whose `HRESULT` returns a thread-safe `JSCallback` cannot give, so
 * the guard Worker polls this module instead. Every call goes through the
 * object's vtable: the first eight bytes of an interface pointer are the vtable
 * address, slot `n` sits at `n * 8`, and each slot is wrapped once in a
 * `CFunction` and kept, because building one per call would be the cost of the
 * whole poll.
 *
 * Nothing here is silent: a `HRESULT` that is not a success throws with the
 * call's name and the value in hex. The one exception is a machine with no
 * render endpoint, which is not a failure and answers `null`.
 */
import { CFunction, dlopen, FFIType, ptr, read } from 'bun:ffi';
import type { Pointer } from 'bun:ffi';

/** One session of one process, with its `ISimpleAudioVolume` held. */
export interface AudioSession {
  /** The process that created the session. Never 0: those are the system sounds. */
  pid: number;
  /** `ISimpleAudioVolume::SetMute`. False when the session is gone or the device changed. */
  mute(on: boolean): boolean;
  /** `ISimpleAudioVolume::GetMute`. Null when the session cannot answer any more. */
  getMute(): boolean | null;
  /** `IUnknown::Release` on the volume interface. Safe to call twice. */
  release(): void;
}

/** The session manager of the default render endpoint, open until `release`. */
export interface AudioSessions {
  /** Every session of the endpoint right now, each holding its own interface. */
  list(): AudioSession[];
  release(): void;
}

// -- COM constants ----------------------------------------------------------

const S_OK = 0;
const S_FALSE = 1;
/** The session spans more than one process; the creator's pid is still written. */
const AUDCLNT_S_NO_SINGLE_PROCESS = 0x0889000d;
/** `HRESULT_FROM_WIN32(ERROR_NOT_FOUND)`: this machine has no such endpoint. */
const E_NOTFOUND = 0x80070490;
const RPC_E_CHANGED_MODE = 0x80010106;

const CLSCTX_INPROC_SERVER = 0x1;
const CLSCTX_ALL = 0x17;
const COINIT_APARTMENTTHREADED = 0x2;

/** `EDataFlow::eRender` and `ERole::eMultimedia`: what the user hears. */
const E_RENDER = 0;
const E_MULTIMEDIA = 1;

/** `IUnknown`, on every interface. */
const SLOT_QUERY_INTERFACE = 0;
const SLOT_RELEASE = 2;
/** `IMMDeviceEnumerator::GetDefaultAudioEndpoint`. */
const SLOT_GET_DEFAULT_ENDPOINT = 4;
/** `IMMDevice::Activate`. */
const SLOT_ACTIVATE = 3;
/** `IAudioSessionManager2::GetSessionEnumerator`, after the two it inherits. */
const SLOT_GET_SESSION_ENUMERATOR = 5;
/** `IAudioSessionEnumerator::GetCount` and `::GetSession`. */
const SLOT_GET_COUNT = 3;
const SLOT_GET_SESSION = 4;
/** `IAudioSessionControl2::GetProcessId`, after the nine of `IAudioSessionControl`. */
const SLOT_GET_PROCESS_ID = 14;
/** `ISimpleAudioVolume::SetMute` and `::GetMute`. */
const SLOT_SET_MUTE = 5;
const SLOT_GET_MUTE = 6;

/** A GUID is 16 bytes: `Data1`, `Data2` and `Data3` little-endian, `Data4` as written. */
function guid(bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

/** {BCDE0395-E52F-467C-8E3D-C4579291692E} `MMDeviceEnumerator` */
const CLSID_MM_DEVICE_ENUMERATOR = guid([
  0x95, 0x03, 0xde, 0xbc, 0x2f, 0xe5, 0x7c, 0x46, 0x8e, 0x3d, 0xc4, 0x57, 0x92, 0x91, 0x69, 0x2e,
]);
/** {A95664D2-9614-4F35-A746-DE8DB63617E6} `IMMDeviceEnumerator` */
const IID_IMM_DEVICE_ENUMERATOR = guid([
  0xd2, 0x64, 0x56, 0xa9, 0x14, 0x96, 0x35, 0x4f, 0xa7, 0x46, 0xde, 0x8d, 0xb6, 0x36, 0x17, 0xe6,
]);
/** {77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F} `IAudioSessionManager2` */
const IID_IAUDIO_SESSION_MANAGER2 = guid([
  0xa0, 0x99, 0xaa, 0x77, 0xd6, 0x1b, 0x4f, 0x48, 0x8b, 0xc7, 0x2c, 0x65, 0x4c, 0x9a, 0x9b, 0x6f,
]);
/** {BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D} `IAudioSessionControl2` */
const IID_IAUDIO_SESSION_CONTROL2 = guid([
  0x88, 0xff, 0xb7, 0xbf, 0x39, 0x72, 0xc9, 0x4f, 0x8f, 0xa2, 0x07, 0xc9, 0x50, 0xbe, 0x9c, 0x6d,
]);
/** {87CE5498-68D6-44E5-9215-6DA47EF883D8} `ISimpleAudioVolume` */
const IID_ISIMPLE_AUDIO_VOLUME = guid([
  0x98, 0x54, 0xce, 0x87, 0xd6, 0x68, 0xe5, 0x44, 0x92, 0x15, 0x6d, 0xa4, 0x7e, 0xf8, 0x83, 0xd8,
]);

// -- ole32 ------------------------------------------------------------------

function loadOle32() {
  return dlopen('ole32.dll', {
    CoInitializeEx: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    CoUninitialize: { args: [], returns: FFIType.void },
    CoCreateInstance: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
  });
}

type Ole32 = ReturnType<typeof loadOle32>['symbols'];

let ole32: Ole32 | null = null;

function ole(): Ole32 {
  if (ole32 === null) ole32 = loadOle32().symbols;
  return ole32;
}

/**
 * COM for this thread, in the apartment the guard Worker's message pump wants.
 * `S_FALSE` means it was already initialized and still needs its own
 * `coUninitialize`, so both count as a success.
 */
export function coInitialize(): void {
  const hr = ole().CoInitializeEx(null, COINIT_APARTMENTTHREADED);
  if (hr === S_OK || hr === S_FALSE) return;
  if ((hr >>> 0) === RPC_E_CHANGED_MODE) {
    throw new Error(`CoInitializeEx: this thread is already in another apartment (${hex(hr)})`);
  }
  throw new Error(`CoInitializeEx failed with ${hex(hr)}`);
}

export function coUninitialize(): void {
  ole().CoUninitialize();
}

// -- calling through a vtable ----------------------------------------------

/** Every COM method here takes `this` first and answers an `HRESULT` or a refcount. */
type ComCall = (...args: (number | bigint | null)[]) => number;

interface Signature {
  args: FFIType[];
  returns: FFIType;
}

const PTR = FFIType.ptr;
const SIG_QUERY_INTERFACE: Signature = { args: [PTR, PTR, PTR], returns: FFIType.i32 };
const SIG_RELEASE: Signature = { args: [PTR], returns: FFIType.u32 };
const SIG_GET_DEFAULT_ENDPOINT: Signature = { args: [PTR, FFIType.i32, FFIType.i32, PTR], returns: FFIType.i32 };
const SIG_ACTIVATE: Signature = { args: [PTR, PTR, FFIType.u32, PTR, PTR], returns: FFIType.i32 };
const SIG_OUT_POINTER: Signature = { args: [PTR, PTR], returns: FFIType.i32 };
const SIG_GET_SESSION: Signature = { args: [PTR, FFIType.i32, PTR], returns: FFIType.i32 };
const SIG_SET_MUTE: Signature = { args: [PTR, FFIType.i32, PTR], returns: FFIType.i32 };

/**
 * One `CFunction` per vtable slot, kept for the life of the process. A slot's
 * address is the same for every object of that interface, so this cache has as
 * many entries as there are methods here, and building one per call would be
 * the whole cost of a poll.
 */
const slotCache = new Map<number, ComCall>();

function slot(self: Pointer, index: number, name: string, signature: Signature): ComCall {
  const vtable = read.ptr(self, 0);
  if (vtable === 0) throw new Error(`${name}: the interface at ${String(self)} has no vtable`);
  const address = read.ptr(vtable, index * 8);
  if (address === 0) throw new Error(`${name}: vtable slot ${index} is empty`);
  const cached = slotCache.get(address);
  if (cached !== undefined) return cached;
  const built = CFunction({ ...signature, ptr: asPointer(address) }) as unknown as ComCall;
  slotCache.set(address, built);
  return built;
}

function hex(hr: number): string {
  return `0x${(hr >>> 0).toString(16).padStart(8, '0')}`;
}

function ok(hr: number, call: string): void {
  if (hr !== S_OK) throw new Error(`${call} failed with ${hex(hr)}`);
}

function asPointer(address: number): Pointer {
  return address as unknown as Pointer;
}

/** Eight zeroed bytes for a `void **` out parameter. */
function outParameter(): BigUint64Array {
  return new BigUint64Array(1);
}

function taken(out: BigUint64Array, call: string): Pointer {
  const address = read.ptr(ptr(out), 0);
  if (address === 0) throw new Error(`${call} answered S_OK and no interface`);
  return asPointer(address);
}

function release(self: Pointer): void {
  slot(self, SLOT_RELEASE, 'IUnknown::Release', SIG_RELEASE)(self);
}

function queryInterface(self: Pointer, iid: Uint8Array, name: string): Pointer {
  const out = outParameter();
  const hr = slot(self, SLOT_QUERY_INTERFACE, 'IUnknown::QueryInterface', SIG_QUERY_INTERFACE)(self, ptr(iid), ptr(out));
  ok(hr, `IUnknown::QueryInterface(${name})`);
  return taken(out, `IUnknown::QueryInterface(${name})`);
}

// -- the endpoint and its sessions -----------------------------------------

/**
 * The session manager of the default render endpoint, or null when the machine
 * has no render endpoint at all (`E_NOTFOUND`), which is a fact rather than a
 * failure: a box with no sound card has nothing to mute.
 */
export function openSessions(): AudioSessions | null {
  if (process.platform !== 'win32') return null;

  const created = outParameter();
  ok(
    ole().CoCreateInstance(
      ptr(CLSID_MM_DEVICE_ENUMERATOR),
      null,
      CLSCTX_INPROC_SERVER,
      ptr(IID_IMM_DEVICE_ENUMERATOR),
      ptr(created),
    ),
    'CoCreateInstance(MMDeviceEnumerator)',
  );
  const enumerator = taken(created, 'CoCreateInstance(MMDeviceEnumerator)');

  let device: Pointer;
  try {
    const out = outParameter();
    const hr = slot(
      enumerator,
      SLOT_GET_DEFAULT_ENDPOINT,
      'IMMDeviceEnumerator::GetDefaultAudioEndpoint',
      SIG_GET_DEFAULT_ENDPOINT,
    )(enumerator, E_RENDER, E_MULTIMEDIA, ptr(out));
    if ((hr >>> 0) === E_NOTFOUND) return null;
    ok(hr, 'IMMDeviceEnumerator::GetDefaultAudioEndpoint');
    device = taken(out, 'IMMDeviceEnumerator::GetDefaultAudioEndpoint');
  } finally {
    release(enumerator);
  }

  let manager: Pointer;
  try {
    const out = outParameter();
    const hr = slot(device, SLOT_ACTIVATE, 'IMMDevice::Activate', SIG_ACTIVATE)(
      device,
      ptr(IID_IAUDIO_SESSION_MANAGER2),
      CLSCTX_ALL,
      null,
      ptr(out),
    );
    ok(hr, 'IMMDevice::Activate(IAudioSessionManager2)');
    manager = taken(out, 'IMMDevice::Activate(IAudioSessionManager2)');
  } finally {
    release(device);
  }

  let open = true;
  return {
    list: (): AudioSession[] => {
      if (!open) throw new Error('IAudioSessionManager2 was already released');
      return listSessions(manager);
    },
    release: (): void => {
      if (!open) return;
      open = false;
      release(manager);
    },
  };
}

/**
 * Walk the endpoint's sessions once. Every interface this opens is released
 * again except the `ISimpleAudioVolume` of a session it hands back, which the
 * caller owns and releases.
 */
function listSessions(manager: Pointer): AudioSession[] {
  const out = outParameter();
  ok(
    slot(manager, SLOT_GET_SESSION_ENUMERATOR, 'IAudioSessionManager2::GetSessionEnumerator', SIG_OUT_POINTER)(
      manager,
      ptr(out),
    ),
    'IAudioSessionManager2::GetSessionEnumerator',
  );
  const sessions = taken(out, 'IAudioSessionManager2::GetSessionEnumerator');

  const found: AudioSession[] = [];
  try {
    const countOut = new Int32Array(1);
    ok(
      slot(sessions, SLOT_GET_COUNT, 'IAudioSessionEnumerator::GetCount', SIG_OUT_POINTER)(sessions, ptr(countOut)),
      'IAudioSessionEnumerator::GetCount',
    );
    const count = countOut[0] ?? 0;

    for (let index = 0; index < count; index += 1) {
      const controlOut = outParameter();
      ok(
        slot(sessions, SLOT_GET_SESSION, 'IAudioSessionEnumerator::GetSession', SIG_GET_SESSION)(
          sessions,
          index,
          ptr(controlOut),
        ),
        'IAudioSessionEnumerator::GetSession',
      );
      const control = taken(controlOut, 'IAudioSessionEnumerator::GetSession');
      const session = readSession(control);
      if (session !== null) found.push(session);
    }
  } catch (error) {
    for (const session of found) session.release();
    throw error;
  } finally {
    release(sessions);
  }
  return found;
}

/**
 * One session's pid and its volume interface. The `IAudioSessionControl` it is
 * given is released here whatever happens: only the volume interface travels.
 */
function readSession(control: Pointer): AudioSession | null {
  let volume: Pointer | null = null;
  try {
    const control2 = queryInterface(control, IID_IAUDIO_SESSION_CONTROL2, 'IAudioSessionControl2');
    let pid: number;
    try {
      const pidOut = new Uint32Array(1);
      const hr = slot(control2, SLOT_GET_PROCESS_ID, 'IAudioSessionControl2::GetProcessId', SIG_OUT_POINTER)(
        control2,
        ptr(pidOut),
      );
      // A session that spans several processes still names the one that opened
      // it, which is the process this core traced.
      if (hr !== S_OK && (hr >>> 0) !== AUDCLNT_S_NO_SINGLE_PROCESS) {
        throw new Error(`IAudioSessionControl2::GetProcessId failed with ${hex(hr)}`);
      }
      pid = pidOut[0] ?? 0;
    } finally {
      release(control2);
    }
    // Pid 0 is the system sounds session: nothing a thread launched owns it.
    if (pid === 0) return null;

    volume = queryInterface(control, IID_ISIMPLE_AUDIO_VOLUME, 'ISimpleAudioVolume');
    return audioSession(pid, volume);
  } finally {
    release(control);
  }
}

function audioSession(pid: number, volume: Pointer): AudioSession {
  let held = true;
  return {
    pid,
    /**
     * A session whose process is already gone answers an error rather than
     * throwing: unmuting one on the way out is best effort by nature.
     */
    mute(on: boolean): boolean {
      if (!held) return false;
      try {
        return slot(volume, SLOT_SET_MUTE, 'ISimpleAudioVolume::SetMute', SIG_SET_MUTE)(volume, on ? 1 : 0, null) === S_OK;
      } catch {
        return false;
      }
    },
    getMute(): boolean | null {
      if (!held) return null;
      try {
        const out = new Int32Array(1);
        const hr = slot(volume, SLOT_GET_MUTE, 'ISimpleAudioVolume::GetMute', SIG_OUT_POINTER)(volume, ptr(out));
        if (hr !== S_OK) return null;
        return (out[0] ?? 0) !== 0;
      } catch {
        return null;
      }
    },
    release(): void {
      if (!held) return;
      held = false;
      release(volume);
    },
  };
}
