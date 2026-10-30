/**
 * The controls of a window a person can act on, read through UI Automation
 * over `bun:ffi`. Windows only; `window-guide.ts` loads it on first use.
 *
 * One `FindAllBuildCache` asks the window's process for every control of the
 * interactive types with the six properties `boite window read` prints, in a
 * single cross-process round trip; nothing is read element by element after.
 * The client keeps no live reference to what it read
 * (`AutomationElementMode_None`).
 *
 * UI Automation runs on the calling thread, which is the core's: a window that
 * is not responding is refused before any call, and the connection and
 * transaction timeouts bound how long a slow provider can hold the thread.
 * Nothing here focuses, invokes or changes a control: `AutoSetFocus` is off
 * and no pattern is ever asked for.
 *
 * Every call goes through the interface's vtable, as in `audio-sessions.ts`.
 */
import { CFunction, dlopen, FFIType, ptr, read, toArrayBuffer } from 'bun:ffi';
import type { Pointer } from 'bun:ffi';
import type { NativeControl } from '../types.ts';

const PTR = FFIType.ptr;
const U64 = FFIType.u64;
const U32 = FFIType.u32;
const I32 = FFIType.i32;
const HR = FFIType.i32;

function loadOle32() {
  return dlopen('ole32.dll', {
    CoInitializeEx: { args: [PTR, U32], returns: HR },
    CoCreateInstance: { args: [PTR, PTR, U32, PTR, PTR], returns: HR },
  }).symbols;
}

function loadOleaut32() {
  return dlopen('oleaut32.dll', {
    SysStringLen: { args: [U64], returns: U32 },
    SysFreeString: { args: [U64], returns: FFIType.void },
  }).symbols;
}

let ole32Symbols: ReturnType<typeof loadOle32> | null = null;
let oleaut32Symbols: ReturnType<typeof loadOleaut32> | null = null;
const ole32 = () => (ole32Symbols ??= loadOle32());
const oleaut32 = () => (oleaut32Symbols ??= loadOleaut32());

// -- calling through a vtable ----------------------------------------------

type ComCall = (...args: (number | bigint | null)[]) => number;

interface Signature {
  args: FFIType[];
  returns: FFIType;
}

const SIG_RELEASE: Signature = { args: [PTR], returns: U32 };
const SIG_OUT: Signature = { args: [PTR, PTR], returns: HR };
const SIG_SET_U32: Signature = { args: [PTR, U32], returns: HR };
const SIG_SET_I32: Signature = { args: [PTR, I32], returns: HR };
const SIG_HANDLE_OUT: Signature = { args: [PTR, U64, PTR], returns: HR };
const SIG_PROPERTY_CONDITION: Signature = { args: [PTR, I32, PTR, PTR], returns: HR };
const SIG_NATIVE_ARRAY: Signature = { args: [PTR, PTR, I32, PTR], returns: HR };
const SIG_FIND_ALL_BUILD_CACHE: Signature = { args: [PTR, I32, PTR, PTR, PTR], returns: HR };
const SIG_INDEX_OUT: Signature = { args: [PTR, I32, PTR], returns: HR };

/** One `CFunction` per vtable slot and signature, kept for the life of the process. */
const slotCache = new Map<Signature, Map<number, ComCall>>();

function slot(self: Pointer, index: number, name: string, signature: Signature): ComCall {
  const vtable = read.ptr(self, 0);
  if (vtable === 0) throw new Error(`${name}: the interface at ${String(self)} has no vtable`);
  const address = read.ptr(vtable, index * 8);
  if (address === 0) throw new Error(`${name}: vtable slot ${index} is empty`);
  let bySignature = slotCache.get(signature);
  if (bySignature === undefined) slotCache.set(signature, (bySignature = new Map()));
  const cached = bySignature.get(address);
  if (cached !== undefined) return cached;
  const built = CFunction({ ...signature, ptr: address as unknown as Pointer }) as unknown as ComCall;
  bySignature.set(address, built);
  return built;
}

/** `UIA_E_TIMEOUT`: the provider did not answer within the transaction timeout. */
const UIA_E_TIMEOUT = 0x80131505;
/** `UIA_E_ELEMENTNOTAVAILABLE`: the window closed during the read. */
const UIA_E_ELEMENTNOTAVAILABLE = 0x80040201;
const RPC_E_CHANGED_MODE = 0x80010106;

function ok(hr: number, call: string): void {
  if (hr >= 0) return;
  const code = hr >>> 0;
  if (code === UIA_E_TIMEOUT) throw new Error(`${call}: the window's app did not answer in time`);
  if (code === UIA_E_ELEMENTNOTAVAILABLE) throw new Error(`${call}: the window closed during the read`);
  throw new Error(`${call} failed with 0x${code.toString(16).padStart(8, '0')}`);
}

function taken(out: BigUint64Array, call: string): Pointer {
  if (out[0] === 0n) throw new Error(`${call} answered S_OK and no interface`);
  return Number(out[0]) as unknown as Pointer;
}

function release(self: Pointer | null): void {
  if (self !== null) slot(self, 2, 'IUnknown::Release', SIG_RELEASE)(self);
}

/** `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}` as 16 bytes: the first three fields little-endian. */
function guid(text: string): Uint8Array {
  const hex = text.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Number.parseInt(hex.slice(0, 8), 16), true);
  view.setUint16(4, Number.parseInt(hex.slice(8, 12), 16), true);
  view.setUint16(6, Number.parseInt(hex.slice(12, 16), 16), true);
  for (let index = 8; index < 16; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

/** A BSTR's text, freed once read. */
function bstr(value: bigint): string {
  if (value === 0n) return '';
  try {
    const length = oleaut32().SysStringLen(value);
    if (length === 0) return '';
    return new TextDecoder('utf-16le').decode(new Uint8Array(toArrayBuffer(Number(value) as unknown as Pointer, 0, length * 2)));
  } finally {
    oleaut32().SysFreeString(value);
  }
}

// -- UI Automation ------------------------------------------------------------

const CLSID_CUIAUTOMATION8 = guid('E22AD333-B25F-460C-83D0-0581107395C9');
const CLSID_CUIAUTOMATION = guid('FF48DBA4-60EF-4201-AA87-54103EEF594E');
const IID_IUIAUTOMATION2 = guid('34723AFF-0C9D-49D0-9896-7AB52DF8CD8A');
const IID_IUIAUTOMATION = guid('30CBE57D-D9D0-452A-AB13-7AC5AC4825EE');
const CLSCTX_INPROC_SERVER = 0x1;
const COINIT_MULTITHREADED = 0x0;

// IUIAutomation (IUIAutomation2 extends it).
const ELEMENT_FROM_HANDLE = 6;
const CREATE_CACHE_REQUEST = 20;
const CREATE_PROPERTY_CONDITION = 23;
const CREATE_OR_CONDITION_FROM_NATIVE_ARRAY = 30;
const PUT_AUTO_SET_FOCUS = 59;
const PUT_CONNECTION_TIMEOUT = 61;
const PUT_TRANSACTION_TIMEOUT = 63;
// IUIAutomationCacheRequest.
const ADD_PROPERTY = 3;
const PUT_AUTOMATION_ELEMENT_MODE = 11;
// IUIAutomationElement.
const FIND_ALL_BUILD_CACHE = 8;
const CACHED_CONTROL_TYPE = 53;
const CACHED_NAME = 55;
const CACHED_IS_ENABLED = 60;
const CACHED_AUTOMATION_ID = 61;
const CACHED_IS_OFFSCREEN = 70;
const CACHED_BOUNDING_RECTANGLE = 75;
// IUIAutomationElementArray.
const ARRAY_LENGTH = 3;
const ARRAY_ELEMENT = 4;

const TREE_SCOPE_DESCENDANTS = 4;
const AUTOMATION_ELEMENT_MODE_NONE = 0;
const VT_I4 = 3;

const PROPERTY = {
  boundingRectangle: 30001,
  controlType: 30003,
  name: 30005,
  isEnabled: 30010,
  automationId: 30011,
  isOffscreen: 30022,
} as const;

/** The control types a person clicks, types into or picks from, by their UIA id. */
export const INTERACTIVE_TYPES: Record<number, string> = {
  50000: 'Button',
  50002: 'CheckBox',
  50003: 'ComboBox',
  50004: 'Edit',
  50005: 'Hyperlink',
  50007: 'ListItem',
  50011: 'MenuItem',
  50013: 'RadioButton',
  50015: 'Slider',
  50016: 'Spinner',
  50019: 'TabItem',
  50024: 'TreeItem',
  50029: 'DataItem',
  50031: 'SplitButton',
  50035: 'HeaderItem',
};

/** How long UI Automation waits to reach a window's process, and for one answer from it. */
const CONNECTION_TIMEOUT_MS = 2_000;
const TRANSACTION_TIMEOUT_MS = 5_000;

interface Automation {
  automation: Pointer;
  cache: Pointer;
  condition: Pointer;
}

let automation: Automation | null = null;

function createAutomation(): Automation {
  const init = ole32().CoInitializeEx(null, COINIT_MULTITHREADED);
  // Another part of the core may have joined an apartment on this thread first: UI Automation works in either.
  if (init < 0 && (init >>> 0) !== RPC_E_CHANGED_MODE) ok(init, 'CoInitializeEx');
  const out = new BigUint64Array(1);
  let self: Pointer;
  let modern = true;
  if (ole32().CoCreateInstance(ptr(CLSID_CUIAUTOMATION8), null, CLSCTX_INPROC_SERVER, ptr(IID_IUIAUTOMATION2), ptr(out)) >= 0 && out[0] !== 0n) {
    self = taken(out, 'CoCreateInstance(CUIAutomation8)');
  } else {
    modern = false;
    ok(ole32().CoCreateInstance(ptr(CLSID_CUIAUTOMATION), null, CLSCTX_INPROC_SERVER, ptr(IID_IUIAUTOMATION), ptr(out)), 'CoCreateInstance(CUIAutomation)');
    self = taken(out, 'CoCreateInstance(CUIAutomation)');
  }
  if (modern) {
    ok(slot(self, PUT_AUTO_SET_FOCUS, 'IUIAutomation2::put_AutoSetFocus', SIG_SET_I32)(self, 0), 'IUIAutomation2::put_AutoSetFocus');
    ok(slot(self, PUT_CONNECTION_TIMEOUT, 'IUIAutomation2::put_ConnectionTimeout', SIG_SET_U32)(self, CONNECTION_TIMEOUT_MS), 'IUIAutomation2::put_ConnectionTimeout');
    ok(slot(self, PUT_TRANSACTION_TIMEOUT, 'IUIAutomation2::put_TransactionTimeout', SIG_SET_U32)(self, TRANSACTION_TIMEOUT_MS), 'IUIAutomation2::put_TransactionTimeout');
  }

  ok(slot(self, CREATE_CACHE_REQUEST, 'IUIAutomation::CreateCacheRequest', SIG_OUT)(self, ptr(out)), 'IUIAutomation::CreateCacheRequest');
  const cache = taken(out, 'IUIAutomation::CreateCacheRequest');
  for (const property of Object.values(PROPERTY)) {
    ok(slot(cache, ADD_PROPERTY, 'IUIAutomationCacheRequest::AddProperty', SIG_SET_I32)(cache, property), 'IUIAutomationCacheRequest::AddProperty');
  }
  ok(slot(cache, PUT_AUTOMATION_ELEMENT_MODE, 'IUIAutomationCacheRequest::put_AutomationElementMode', SIG_SET_I32)(cache, AUTOMATION_ELEMENT_MODE_NONE),
    'IUIAutomationCacheRequest::put_AutomationElementMode');

  // ControlType == Button OR ControlType == CheckBox OR ...: a VARIANT goes by pointer on x64, being 24 bytes.
  const conditions: Pointer[] = [];
  try {
    for (const type of Object.keys(INTERACTIVE_TYPES).map(Number)) {
      const variant = new DataView(new ArrayBuffer(24));
      variant.setUint16(0, VT_I4, true);
      variant.setInt32(8, type, true);
      ok(slot(self, CREATE_PROPERTY_CONDITION, 'IUIAutomation::CreatePropertyCondition', SIG_PROPERTY_CONDITION)(self, PROPERTY.controlType, ptr(variant), ptr(out)),
        'IUIAutomation::CreatePropertyCondition');
      conditions.push(taken(out, 'IUIAutomation::CreatePropertyCondition'));
    }
    const array = new BigUint64Array(conditions.map(condition => BigInt(condition as unknown as number)));
    ok(slot(self, CREATE_OR_CONDITION_FROM_NATIVE_ARRAY, 'IUIAutomation::CreateOrConditionFromNativeArray', SIG_NATIVE_ARRAY)(self, ptr(array), array.length, ptr(out)),
      'IUIAutomation::CreateOrConditionFromNativeArray');
  } finally {
    for (const condition of conditions) release(condition);
  }
  return { automation: self, cache, condition: taken(out, 'IUIAutomation::CreateOrConditionFromNativeArray') };
}

function element(array: Pointer, index: number, out: BigUint64Array): Pointer | null {
  out[0] = 0n;
  if (slot(array, ARRAY_ELEMENT, 'IUIAutomationElementArray::GetElement', SIG_INDEX_OUT)(array, index, ptr(out)) < 0 || out[0] === 0n) return null;
  return Number(out[0]) as unknown as Pointer;
}

function cachedText(self: Pointer, index: number, name: string, out: BigUint64Array): string {
  out[0] = 0n;
  if (slot(self, index, name, SIG_OUT)(self, ptr(out)) < 0) return '';
  return bstr(out[0]!);
}

function cachedInt(self: Pointer, index: number, name: string, out: Int32Array): number | null {
  out[0] = 0;
  return slot(self, index, name, SIG_OUT)(self, ptr(out)) < 0 ? null : out[0]!;
}

/**
 * The enabled, on-screen controls of the interactive types inside the window
 * `hwnd`, in the tree's order, with their bounds in physical screen pixels:
 * the calling thread must be per-monitor aware. At most `limit` come back;
 * `total` counts every one that qualified.
 */
export function readControls(hwnd: bigint, limit: number): { controls: NativeControl[]; total: number } {
  automation ??= createAutomation();
  const { automation: self, cache, condition } = automation;
  const out = new BigUint64Array(1);
  ok(slot(self, ELEMENT_FROM_HANDLE, 'IUIAutomation::ElementFromHandle', SIG_HANDLE_OUT)(self, hwnd, ptr(out)), 'IUIAutomation::ElementFromHandle');
  const root = taken(out, 'IUIAutomation::ElementFromHandle');
  let found: Pointer | null = null;
  try {
    ok(slot(root, FIND_ALL_BUILD_CACHE, 'IUIAutomationElement::FindAllBuildCache', SIG_FIND_ALL_BUILD_CACHE)(root, TREE_SCOPE_DESCENDANTS, condition, cache, ptr(out)),
      'IUIAutomationElement::FindAllBuildCache');
    // No match answers S_OK with no array.
    if (out[0] === 0n) return { controls: [], total: 0 };
    found = Number(out[0]) as unknown as Pointer;
    const count = new Int32Array(1);
    ok(slot(found, ARRAY_LENGTH, 'IUIAutomationElementArray::get_Length', SIG_OUT)(found, ptr(count)), 'IUIAutomationElementArray::get_Length');
    const controls: NativeControl[] = [];
    let total = 0;
    const number = new Int32Array(1);
    const rect = new Int32Array(4);
    for (let index = 0; index < count[0]!; index += 1) {
      const item = element(found, index, out);
      if (item === null) continue;
      try {
        if (cachedInt(item, CACHED_IS_ENABLED, 'get_CachedIsEnabled', number) === 0) continue;
        if (cachedInt(item, CACHED_IS_OFFSCREEN, 'get_CachedIsOffscreen', number) !== 0) continue;
        if (slot(item, CACHED_BOUNDING_RECTANGLE, 'get_CachedBoundingRectangle', SIG_OUT)(item, ptr(rect)) < 0) continue;
        const width = rect[2]! - rect[0]!;
        const height = rect[3]! - rect[1]!;
        if (width <= 0 || height <= 0) continue;
        const type = INTERACTIVE_TYPES[cachedInt(item, CACHED_CONTROL_TYPE, 'get_CachedControlType', number) ?? 0];
        if (type === undefined) continue;
        const name = cachedText(item, CACHED_NAME, 'get_CachedName', out).replace(/\s+/g, ' ').trim();
        const automationId = cachedText(item, CACHED_AUTOMATION_ID, 'get_CachedAutomationId', out);
        // A control with neither is nothing an agent can name to a person.
        if (name === '' && automationId === '') continue;
        total += 1;
        if (controls.length < limit) controls.push({ type, name, automationId, rect: { left: rect[0]!, top: rect[1]!, width, height } });
      } finally {
        release(item);
      }
    }
    return { controls, total };
  } finally {
    release(found);
    release(root);
  }
}
