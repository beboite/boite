/**
 * The Windows.Graphics.Capture half of `window-capture.ts`: a capture item,
 * free-threaded frame pool and session for one window, and a frame's pixels
 * read back through a D3D11 staging texture. Runs on the calling thread in
 * the multithreaded apartment; frames are polled, so no DispatcherQueue.
 *
 * COM and WinRT calls go through vtables as in `audio-sessions.ts`. Every slot
 * number below was checked against the 10.0.26100 SDK headers
 * (`winrt/windows.graphics.capture.h`, `um/d3d11.h`, the two interop headers).
 */
import { CFunction, dlopen, FFIType, ptr, read, toArrayBuffer } from 'bun:ffi';
import type { Pointer } from 'bun:ffi';
import type { WindowPixels } from '../types.ts';

const U64 = FFIType.u64;
const PTR = FFIType.ptr;
const I32 = FFIType.i32;
const U32 = FFIType.u32;

function loadCombase() {
  return dlopen('combase.dll', {
    RoInitialize: { args: [U32], returns: I32 },
    WindowsCreateString: { args: [PTR, U32, PTR], returns: I32 },
    WindowsDeleteString: { args: [U64], returns: I32 },
    RoGetActivationFactory: { args: [U64, PTR, PTR], returns: I32 },
  }).symbols;
}

function loadD3d11() {
  return dlopen('d3d11.dll', {
    D3D11CreateDevice: { args: [PTR, I32, PTR, U32, PTR, U32, U32, PTR, PTR, PTR], returns: I32 },
    CreateDirect3D11DeviceFromDXGIDevice: { args: [PTR, PTR], returns: I32 },
  }).symbols;
}

let combaseSymbols: ReturnType<typeof loadCombase> | null = null;
let d3d11Symbols: ReturnType<typeof loadD3d11> | null = null;

const combase = () => (combaseSymbols ??= loadCombase());
const d3d11 = () => (d3d11Symbols ??= loadD3d11());

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// -- calling through a vtable ----------------------------------------------

type ComCall = (...args: (number | bigint | null)[]) => number;

interface Signature {
  args: FFIType[];
  returns: FFIType;
}

const HR = FFIType.i32;
const SIG_QUERY_INTERFACE: Signature = { args: [PTR, PTR, PTR], returns: HR };
const SIG_RELEASE: Signature = { args: [PTR], returns: FFIType.u32 };
const SIG_THIS: Signature = { args: [PTR], returns: HR };
const SIG_OUT: Signature = { args: [PTR, PTR], returns: HR };
/** WinRT's `boolean` is one byte. */
const SIG_SET_BOOL: Signature = { args: [PTR, FFIType.u8], returns: HR };
const SIG_CREATE_FOR_WINDOW: Signature = { args: [PTR, U64, PTR, PTR], returns: HR };
const SIG_CREATE_FREE_THREADED: Signature = { args: [PTR, PTR, I32, I32, U64, PTR], returns: HR };
const SIG_RECREATE: Signature = { args: [PTR, PTR, I32, I32, U64], returns: HR };
const SIG_IN_OUT: Signature = { args: [PTR, PTR, PTR], returns: HR };
const SIG_GET_DESC: Signature = { args: [PTR, PTR], returns: FFIType.void };
const SIG_CREATE_TEXTURE: Signature = { args: [PTR, PTR, PTR, PTR], returns: HR };
const SIG_COPY_RESOURCE: Signature = { args: [PTR, PTR, PTR], returns: FFIType.void };
const SIG_MAP: Signature = { args: [PTR, PTR, U32, U32, U32, PTR], returns: HR };
const SIG_UNMAP: Signature = { args: [PTR, PTR, U32], returns: FFIType.void };

/**
 * One `CFunction` per vtable slot and signature, kept for the life of the
 * process. Keyed by signature too: a linker that folds two identical methods
 * gives two slots one address, and each must keep its own argument list.
 */
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

function hex(hr: number): string {
  return `0x${(hr >>> 0).toString(16).padStart(8, '0')}`;
}

class ComError extends Error {
  constructor(
    readonly call: string,
    readonly hr: number,
  ) {
    super(`${call} failed with ${hex(hr)}`);
  }
}

function ok(hr: number, call: string): void {
  if (hr < 0) throw new ComError(call, hr);
}

function taken(out: BigUint64Array, call: string): Pointer {
  if (out[0] === 0n) throw new Error(`${call} answered S_OK and no interface`);
  return Number(out[0]) as unknown as Pointer;
}

function release(self: Pointer | null): void {
  if (self !== null) slot(self, 2, 'IUnknown::Release', SIG_RELEASE)(self);
}

function tryQueryInterface(self: Pointer, iid: Uint8Array): Pointer | null {
  const out = new BigUint64Array(1);
  const hr = slot(self, 0, 'IUnknown::QueryInterface', SIG_QUERY_INTERFACE)(self, ptr(iid), ptr(out));
  return hr < 0 || out[0] === 0n ? null : (Number(out[0]) as unknown as Pointer);
}

function queryInterface(self: Pointer, iid: Uint8Array, name: string): Pointer {
  const out = new BigUint64Array(1);
  ok(slot(self, 0, 'IUnknown::QueryInterface', SIG_QUERY_INTERFACE)(self, ptr(iid), ptr(out)), `QueryInterface(${name})`);
  return taken(out, `QueryInterface(${name})`);
}

/** `IClosable::Close`, then the reference itself. Closing first stops a capture at once. */
export function closeAndRelease(self: Pointer | null): void {
  if (self === null) return;
  const closable = tryQueryInterface(self, IID_CLOSABLE);
  if (closable !== null) {
    slot(closable, 6, 'IClosable::Close', SIG_THIS)(closable);
    release(closable);
  }
  release(self);
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

const IID_GRAPHICS_CAPTURE_ITEM_INTEROP = guid('3628E81B-3CAC-4C60-B7F4-23CE0E0C3356');
const IID_GRAPHICS_CAPTURE_ITEM = guid('79C3F95B-31F7-4EC2-A464-632EF5D30760');
const IID_DXGI_DEVICE = guid('54EC77FA-1377-44E6-8C32-88FD5F44C84C');
const IID_DIRECT3D_DEVICE = guid('A37624AB-8D5F-4650-9D3E-9EAE3D9BC670');
const IID_FRAME_POOL_STATICS2 = guid('589B103F-6BBC-5DF5-A991-02E28B3B66D5');
const IID_CAPTURE_SESSION2 = guid('2C39AE40-7D2E-5044-804E-8B6799D4CF9E');
const IID_CAPTURE_SESSION3 = guid('F2CDD966-22AE-5EA1-9596-3A289344C3BE');
const IID_DXGI_INTERFACE_ACCESS = guid('A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1');
const IID_TEXTURE_2D = guid('6F15AAF2-D208-4E89-9AB4-489535D34F9C');
const IID_CLOSABLE = guid('30D5A829-7FA4-4026-83BB-D75BAE4EA99E');

// -- Windows.Graphics.Capture -------------------------------------------------

const RO_INIT_MULTITHREADED = 1;
const RPC_E_CHANGED_MODE = 0x80010106;
const D3D_DRIVER_TYPE_HARDWARE = 1;
const D3D_DRIVER_TYPE_WARP = 5;
const D3D11_CREATE_DEVICE_BGRA_SUPPORT = 0x20;
const D3D11_SDK_VERSION = 7;
/** `DirectXPixelFormat.B8G8R8A8UIntNormalized`, which is `DXGI_FORMAT_B8G8R8A8_UNORM`. */
const B8G8R8A8 = 87;
const D3D11_USAGE_STAGING = 3;
const D3D11_CPU_ACCESS_READ = 0x20000;
const D3D11_MAP_READ = 1;
/** The device went away under a driver update or a reset: the next capture builds a new one. */
const DEVICE_LOST = new Set([0x887a0005, 0x887a0007, 0x887a0006]);
/** How long the first frame of a session may take. */
export const FIRST_FRAME_MS = 1500;
export const POLL_MS = 4;

/** The device, its context and the WinRT wrapper WGC takes, built once and kept. */
interface Gpu {
  device: Pointer;
  context: Pointer;
  direct3d: Pointer;
}

let roInitialized = false;
let gpu: Gpu | null = null;
let itemInterop: Pointer | null = null;
let poolStatics: Pointer | null = null;
/** Why WGC can never work in this process (no class, no factory), kept so each capture does not ask again. */
let wgcMissing: string | null = null;

function roInitialize(): void {
  if (roInitialized) return;
  const hr = combase().RoInitialize(RO_INIT_MULTITHREADED);
  // An apartment someone else set up on this thread serves as well.
  if (hr < 0 && (hr >>> 0) !== RPC_E_CHANGED_MODE) throw new ComError('RoInitialize', hr);
  roInitialized = true;
}

function activationFactory(className: string, iid: Uint8Array): Pointer {
  const name = Buffer.from(`${className}\0`, 'utf16le');
  const handle = new BigUint64Array(1);
  ok(combase().WindowsCreateString(ptr(name), className.length, ptr(handle)), `WindowsCreateString(${className})`);
  try {
    const out = new BigUint64Array(1);
    ok(combase().RoGetActivationFactory(handle[0]!, ptr(iid), ptr(out)), `RoGetActivationFactory(${className})`);
    return taken(out, `RoGetActivationFactory(${className})`);
  } finally {
    combase().WindowsDeleteString(handle[0]!);
  }
}

function factories(): { interop: Pointer; statics: Pointer } {
  if (wgcMissing !== null) throw new Error(wgcMissing);
  if (itemInterop === null || poolStatics === null) {
    try {
      roInitialize();
      itemInterop ??= activationFactory('Windows.Graphics.Capture.GraphicsCaptureItem', IID_GRAPHICS_CAPTURE_ITEM_INTEROP);
      poolStatics ??= activationFactory('Windows.Graphics.Capture.Direct3D11CaptureFramePool', IID_FRAME_POOL_STATICS2);
    } catch (error) {
      wgcMissing = `Windows.Graphics.Capture is unavailable: ${message(error)}`;
      throw new Error(wgcMissing);
    }
  }
  return { interop: itemInterop, statics: poolStatics };
}

function createDevice(): Gpu {
  const api = d3d11();
  let device: Pointer | null = null;
  let context: Pointer | null = null;
  let failure = '';
  for (const driver of [D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP]) {
    const deviceOut = new BigUint64Array(1);
    const contextOut = new BigUint64Array(1);
    const hr = api.D3D11CreateDevice(null, driver, null, D3D11_CREATE_DEVICE_BGRA_SUPPORT, null, 0, D3D11_SDK_VERSION, ptr(deviceOut), null, ptr(contextOut));
    if (hr >= 0 && deviceOut[0] !== 0n && contextOut[0] !== 0n) {
      device = Number(deviceOut[0]) as unknown as Pointer;
      context = Number(contextOut[0]) as unknown as Pointer;
      break;
    }
    failure += `${failure === '' ? '' : ', '}driver ${driver}: ${hex(hr)}`;
  }
  if (device === null || context === null) throw new Error(`D3D11CreateDevice failed (${failure})`);
  let dxgi: Pointer | null = null;
  let inspectable: Pointer | null = null;
  try {
    dxgi = queryInterface(device, IID_DXGI_DEVICE, 'IDXGIDevice');
    const out = new BigUint64Array(1);
    ok(api.CreateDirect3D11DeviceFromDXGIDevice(dxgi, ptr(out)), 'CreateDirect3D11DeviceFromDXGIDevice');
    inspectable = taken(out, 'CreateDirect3D11DeviceFromDXGIDevice');
    const direct3d = queryInterface(inspectable, IID_DIRECT3D_DEVICE, 'IDirect3DDevice');
    return { device, context, direct3d };
  } catch (error) {
    release(context);
    release(device);
    throw error;
  } finally {
    release(inspectable);
    release(dxgi);
  }
}

function devices(): Gpu {
  gpu ??= createDevice();
  return gpu;
}

/** Drops the device after it was lost, so the next capture starts on a new one. */
export function forgetDevice(error: unknown): void {
  if (!(error instanceof ComError) || !DEVICE_LOST.has(error.hr >>> 0) || gpu === null) return;
  const lost = gpu;
  gpu = null;
  releaseStaging();
  for (const object of [lost.direct3d, lost.context, lost.device]) {
    try { release(object); } catch { /* a lost device may refuse even this */ }
  }
}

function size64(width: number, height: number): bigint {
  return BigInt(width >>> 0) | (BigInt(height >>> 0) << 32n);
}

/** One `GraphicsCaptureItem`, frame pool and running session for one window. */
export class Capture {
  private item: Pointer | null = null;
  private pool: Pointer | null = null;
  private session: Pointer | null = null;
  width = 0;
  height = 0;

  constructor(hwnd: bigint, private readonly buffers: number) {
    const { interop, statics } = factories();
    const { direct3d } = devices();
    try {
      const itemOut = new BigUint64Array(1);
      ok(slot(interop, 3, 'IGraphicsCaptureItemInterop::CreateForWindow', SIG_CREATE_FOR_WINDOW)(interop, hwnd, ptr(IID_GRAPHICS_CAPTURE_ITEM), ptr(itemOut)),
        'IGraphicsCaptureItemInterop::CreateForWindow');
      this.item = taken(itemOut, 'IGraphicsCaptureItemInterop::CreateForWindow');
      const size = new Int32Array(2);
      ok(slot(this.item, 7, 'IGraphicsCaptureItem::get_Size', SIG_OUT)(this.item, ptr(size)), 'IGraphicsCaptureItem::get_Size');
      this.width = Math.max(1, size[0]!);
      this.height = Math.max(1, size[1]!);
      const poolOut = new BigUint64Array(1);
      ok(slot(statics, 6, 'IDirect3D11CaptureFramePoolStatics2::CreateFreeThreaded', SIG_CREATE_FREE_THREADED)(
        statics, direct3d, B8G8R8A8, buffers, size64(this.width, this.height), ptr(poolOut)),
        'IDirect3D11CaptureFramePoolStatics2::CreateFreeThreaded');
      this.pool = taken(poolOut, 'IDirect3D11CaptureFramePoolStatics2::CreateFreeThreaded');
      const sessionOut = new BigUint64Array(1);
      ok(slot(this.pool, 10, 'IDirect3D11CaptureFramePool::CreateCaptureSession', SIG_IN_OUT)(this.pool, this.item, ptr(sessionOut)),
        'IDirect3D11CaptureFramePool::CreateCaptureSession');
      this.session = taken(sessionOut, 'IDirect3D11CaptureFramePool::CreateCaptureSession');
      // No cursor in the picture, and no yellow border where Windows lets an app drop it.
      const session2 = tryQueryInterface(this.session, IID_CAPTURE_SESSION2);
      if (session2 !== null) {
        slot(session2, 7, 'IGraphicsCaptureSession2::put_IsCursorCaptureEnabled', SIG_SET_BOOL)(session2, 0);
        release(session2);
      }
      const session3 = tryQueryInterface(this.session, IID_CAPTURE_SESSION3);
      if (session3 !== null) {
        slot(session3, 7, 'IGraphicsCaptureSession3::put_IsBorderRequired', SIG_SET_BOOL)(session3, 0);
        release(session3);
      }
      ok(slot(this.session, 6, 'IGraphicsCaptureSession::StartCapture', SIG_THIS)(this.session), 'IGraphicsCaptureSession::StartCapture');
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** The oldest frame waiting in the pool, or null. The caller closes it. */
  nextFrame(): Pointer | null {
    if (this.pool === null) return null;
    const out = new BigUint64Array(1);
    ok(slot(this.pool, 7, 'IDirect3D11CaptureFramePool::TryGetNextFrame', SIG_OUT)(this.pool, ptr(out)), 'IDirect3D11CaptureFramePool::TryGetNextFrame');
    return out[0] === 0n ? null : (Number(out[0]) as unknown as Pointer);
  }

  /** The pool's buffers at the window's new size; frames already taken stay valid. */
  resize(width: number, height: number): void {
    if (this.pool === null || (width === this.width && height === this.height)) return;
    ok(slot(this.pool, 6, 'IDirect3D11CaptureFramePool::Recreate', SIG_RECREATE)(this.pool, devices().direct3d, B8G8R8A8, this.buffers, size64(width, height)),
      'IDirect3D11CaptureFramePool::Recreate');
    this.width = width;
    this.height = height;
  }

  close(): void {
    const { session, pool, item } = this;
    this.session = null;
    this.pool = null;
    this.item = null;
    closeAndRelease(session);
    closeAndRelease(pool);
    release(item);
  }
}

/** One staging texture the GPU copies a frame into for the CPU to read, kept between pictures of one size. */
let staging: { texture: Pointer; width: number; height: number } | null = null;

function releaseStaging(): void {
  const held = staging;
  staging = null;
  if (held !== null) release(held.texture);
}

function stagingTexture(width: number, height: number): Pointer {
  if (staging !== null && staging.width === width && staging.height === height) return staging.texture;
  releaseStaging();
  // D3D11_TEXTURE2D_DESC: Width, Height, MipLevels, ArraySize, Format,
  // SampleDesc.Count, SampleDesc.Quality, Usage, BindFlags, CPUAccessFlags, MiscFlags.
  const desc = new Uint32Array([width, height, 1, 1, B8G8R8A8, 1, 0, D3D11_USAGE_STAGING, 0, D3D11_CPU_ACCESS_READ, 0]);
  const { device } = devices();
  const out = new BigUint64Array(1);
  ok(slot(device, 5, 'ID3D11Device::CreateTexture2D', SIG_CREATE_TEXTURE)(device, ptr(desc), null, ptr(out)), 'ID3D11Device::CreateTexture2D');
  const texture = taken(out, 'ID3D11Device::CreateTexture2D');
  staging = { texture, width, height };
  return texture;
}

/**
 * A frame's pixels, cut to its content size: the texture is the pool's size,
 * which can be larger. `content` is the window's size now, which can also be
 * larger than the texture until the pool is recreated.
 */
export function framePixels(frame: Pointer): { pixels: WindowPixels; content: { width: number; height: number } } {
  const contentSize = new Int32Array(2);
  ok(slot(frame, 8, 'IDirect3D11CaptureFrame::get_ContentSize', SIG_OUT)(frame, ptr(contentSize)), 'IDirect3D11CaptureFrame::get_ContentSize');
  const surfaceOut = new BigUint64Array(1);
  ok(slot(frame, 6, 'IDirect3D11CaptureFrame::get_Surface', SIG_OUT)(frame, ptr(surfaceOut)), 'IDirect3D11CaptureFrame::get_Surface');
  const surface = taken(surfaceOut, 'IDirect3D11CaptureFrame::get_Surface');
  let access: Pointer | null = null;
  let texture: Pointer | null = null;
  try {
    access = queryInterface(surface, IID_DXGI_INTERFACE_ACCESS, 'IDirect3DDxgiInterfaceAccess');
    const textureOut = new BigUint64Array(1);
    ok(slot(access, 3, 'IDirect3DDxgiInterfaceAccess::GetInterface', SIG_IN_OUT)(access, ptr(IID_TEXTURE_2D), ptr(textureOut)),
      'IDirect3DDxgiInterfaceAccess::GetInterface(ID3D11Texture2D)');
    texture = taken(textureOut, 'IDirect3DDxgiInterfaceAccess::GetInterface(ID3D11Texture2D)');
    const desc = new Uint32Array(11);
    slot(texture, 10, 'ID3D11Texture2D::GetDesc', SIG_GET_DESC)(texture, ptr(desc));
    const [textureWidth, textureHeight, , , format] = desc;
    if (format !== B8G8R8A8) throw new Error(`the captured texture has DXGI format ${format}, expected ${B8G8R8A8}`);
    const width = Math.min(textureWidth!, Math.max(0, contentSize[0]!));
    const height = Math.min(textureHeight!, Math.max(0, contentSize[1]!));
    if (width === 0 || height === 0) throw new Error(`the captured frame is ${width}x${height}`);

    const copy = stagingTexture(textureWidth!, textureHeight!);
    const { context } = devices();
    slot(context, 47, 'ID3D11DeviceContext::CopyResource', SIG_COPY_RESOURCE)(context, copy, texture);
    // D3D11_MAPPED_SUBRESOURCE: pData, RowPitch, DepthPitch.
    const mapped = new BigUint64Array(2);
    ok(slot(context, 14, 'ID3D11DeviceContext::Map', SIG_MAP)(context, copy, 0, D3D11_MAP_READ, 0, ptr(mapped)), 'ID3D11DeviceContext::Map');
    try {
      const data = Number(mapped[0]);
      const rowPitch = Number(mapped[1]! & 0xffff_ffffn);
      if (data === 0 || rowPitch < width * 4) throw new Error(`ID3D11DeviceContext::Map gave row pitch ${rowPitch} for ${width} pixels`);
      const source = new Uint8Array(toArrayBuffer(data as unknown as Pointer, 0, rowPitch * (height - 1) + width * 4));
      const bgra = new Uint8Array(width * height * 4);
      for (let row = 0; row < height; row += 1) bgra.set(source.subarray(row * rowPitch, row * rowPitch + width * 4), row * width * 4);
      return { pixels: { width, height, bgra, via: 'wgc' }, content: { width: contentSize[0]!, height: contentSize[1]! } };
    } finally {
      slot(context, 15, 'ID3D11DeviceContext::Unmap', SIG_UNMAP)(context, copy, 0);
    }
  } finally {
    release(texture);
    release(access);
    release(surface);
  }
}
