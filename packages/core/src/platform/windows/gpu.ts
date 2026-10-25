/**
 * GPU load on Windows, for every vendor: DXGI names the adapters and their
 * dedicated memory, the PDH "GPU Engine" and "GPU Adapter Memory" counters say
 * how busy each engine is and how much memory is in use. The engine counters
 * are per process, so the same reading gives each agent its share.
 *
 * Nothing loads before the first read. The PDH query stays open between reads
 * (a utilization is the difference between two collections) and closes once
 * nobody has asked for `IDLE_CLOSE_MS`.
 */
import { CFunction, dlopen, FFIType, ptr, read, type Pointer } from 'bun:ffi';
import type { MachineGpu } from '@boite/contracts';

const PTR = FFIType.ptr;
const S_OK = 0;
const DXGI_ERROR_NOT_FOUND = 0x887a0002;
const DXGI_ADAPTER_FLAG_SOFTWARE = 2;
const PDH_MORE_DATA = 0x800007d2;
const PDH_FMT_DOUBLE = 0x200;
const PDH_CSTATUS_NEW_DATA = 1;
/** A first reading has no interval: wait this long and collect again. */
const FIRST_INTERVAL_MS = 250;
const IDLE_CLOSE_MS = 30_000;
const ADAPTERS_TTL_MS = 60_000;

// {770aae78-f26f-4dba-a829-253c83d1b387}
const IID_IDXGIFactory1 = new Uint8Array([0x78, 0xae, 0x0a, 0x77, 0x6f, 0xf2, 0xba, 0x4d, 0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87]);

interface Adapter { luid: string; name: string; memoryTotalBytes: number }

function loadDxgi() {
  return dlopen('dxgi.dll', { CreateDXGIFactory1: { args: [PTR, PTR], returns: FFIType.i32 } });
}

function loadPdh() {
  return dlopen('pdh.dll', {
    PdhOpenQueryW: { args: [PTR, FFIType.u64, PTR], returns: FFIType.u32 },
    PdhAddEnglishCounterW: { args: [PTR, PTR, FFIType.u64, PTR], returns: FFIType.u32 },
    PdhCollectQueryData: { args: [PTR], returns: FFIType.u32 },
    PdhGetFormattedCounterArrayW: { args: [PTR, FFIType.u32, PTR, PTR, PTR], returns: FFIType.u32 },
    PdhCloseQuery: { args: [PTR], returns: FFIType.u32 },
  });
}

let dxgi: ReturnType<typeof loadDxgi>['symbols'] | null = null;
let pdh: ReturnType<typeof loadPdh>['symbols'] | null = null;

type ComCall = (...args: (number | Pointer | null)[]) => number;
const slots = new Map<number, ComCall>();

function slot(self: Pointer, index: number, args: FFIType[], returns: FFIType): ComCall {
  const address = read.ptr(read.ptr(self, 0) as unknown as Pointer, index * 8);
  let call = slots.get(address);
  if (call === undefined) {
    call = CFunction({ args: [PTR, ...args], returns, ptr: address as unknown as Pointer }) as unknown as ComCall;
    slots.set(address, call);
  }
  return call;
}

const release = (self: Pointer) => slot(self, 2, [], FFIType.u32)(self);

const hex8 = (value: number) => `0x${(value >>> 0).toString(16).padStart(8, '0')}`;

/** PDH writes an adapter's LUID as `luid_0x<high>_0x<low>`. */
const luidKey = (high: number, low: number) => `${hex8(high)}_${hex8(low)}`;

function utf16(bytes: Uint8Array, offset: number, maxChars: number): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  let end = offset;
  while (end - offset < maxChars * 2 && end + 1 < bytes.byteLength && view.getUint16(end, true) !== 0) end += 2;
  return new TextDecoder('utf-16le').decode(bytes.subarray(offset, end));
}

/** Hardware adapters, the software rasterizer left out. */
export function enumerateAdapters(): Adapter[] {
  dxgi ??= loadDxgi().symbols;
  const out = new BigUint64Array(1);
  if (dxgi.CreateDXGIFactory1(ptr(IID_IDXGIFactory1), ptr(out)) !== S_OK || out[0] === 0n) return [];
  const factory = Number(out[0]) as unknown as Pointer;
  const adapters: Adapter[] = [];
  try {
    // IDXGIFactory1::EnumAdapters1 is slot 12; IDXGIAdapter1::GetDesc1 is slot 10.
    const enumAdapters = slot(factory, 12, [FFIType.u32, PTR], FFIType.i32);
    for (let index = 0; index < 16; index++) {
      const adapterOut = new BigUint64Array(1);
      const hr = enumAdapters(factory, index, ptr(adapterOut)) >>> 0;
      if (hr === DXGI_ERROR_NOT_FOUND || hr !== S_OK) break;
      const adapter = Number(adapterOut[0]) as unknown as Pointer;
      try {
        // DXGI_ADAPTER_DESC1: Description[128] WCHAR, four UINTs, three SIZE_Ts, LUID, Flags.
        const desc = new Uint8Array(312);
        if (slot(adapter, 10, [PTR], FFIType.i32)(adapter, ptr(desc)) !== S_OK) continue;
        const view = new DataView(desc.buffer);
        if ((view.getUint32(304, true) & DXGI_ADAPTER_FLAG_SOFTWARE) !== 0) continue;
        adapters.push({
          name: utf16(desc, 0, 128).trim(),
          memoryTotalBytes: Number(view.getBigUint64(272, true)),
          luid: luidKey(view.getInt32(300, true), view.getUint32(296, true)),
        });
      } finally { release(adapter); }
    }
  } finally { release(factory); }
  return adapters;
}

interface Item { name: string; value: number }

function wide(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(`${text}\0`, 'utf16le'));
}

class GpuQuery {
  private readonly query: number;
  private readonly engine: number;
  private readonly memory: number;
  collectedAt = 0;

  constructor() {
    pdh ??= loadPdh().symbols;
    const out = new BigUint64Array(1);
    if (pdh.PdhOpenQueryW(null, 0, ptr(out)) !== S_OK) throw new Error('PdhOpenQueryW failed');
    this.query = Number(out[0]);
    this.engine = this.add('\\GPU Engine(*)\\Utilization Percentage');
    this.memory = this.add('\\GPU Adapter Memory(*)\\Dedicated Usage');
  }

  private add(path: string): number {
    const out = new BigUint64Array(1);
    const status = pdh!.PdhAddEnglishCounterW(this.query as unknown as Pointer, ptr(wide(path)), 0, ptr(out));
    if (status !== S_OK) { this.close(); throw new Error(`PdhAddEnglishCounterW ${path} failed with ${hex8(status)}`); }
    return Number(out[0]);
  }

  collect(): boolean {
    const ok = pdh!.PdhCollectQueryData(this.query as unknown as Pointer) === S_OK;
    if (ok) this.collectedAt = Date.now();
    return ok;
  }

  items(counter: 'engine' | 'memory'): Item[] {
    const handle = (counter === 'engine' ? this.engine : this.memory) as unknown as Pointer;
    const size = new Uint32Array(1);
    const count = new Uint32Array(1);
    const first = pdh!.PdhGetFormattedCounterArrayW(handle, PDH_FMT_DOUBLE, ptr(size), ptr(count), null) >>> 0;
    if (first !== PDH_MORE_DATA || size[0] === 0) return [];
    const buffer = new Uint8Array(size[0]!);
    if (pdh!.PdhGetFormattedCounterArrayW(handle, PDH_FMT_DOUBLE, ptr(size), ptr(count), ptr(buffer)) !== S_OK) return [];
    const base = ptr(buffer) as unknown as number;
    const view = new DataView(buffer.buffer);
    const items: Item[] = [];
    // PDH_FMT_COUNTERVALUE_ITEM_W: the name pointer, then CStatus, padding and the double.
    for (let index = 0; index < count[0]!; index++) {
      const at = index * 24;
      const status = view.getUint32(at + 8, true);
      if (status !== S_OK && status !== PDH_CSTATUS_NEW_DATA) continue;
      const nameAt = read.ptr(ptr(buffer), at) - base;
      if (nameAt < 0 || nameAt >= buffer.byteLength) continue;
      items.push({ name: utf16(buffer, nameAt, 512), value: view.getFloat64(at + 16, true) });
    }
    return items;
  }

  close(): void {
    pdh?.PdhCloseQuery(this.query as unknown as Pointer);
  }
}

const ENGINE = /^pid_(\d+)_luid_(0x[0-9a-f]+)_(0x[0-9a-f]+)_phys_(\d+)_eng_(\d+)_/i;
const MEMORY = /^luid_(0x[0-9a-f]+)_(0x[0-9a-f]+)_phys_\d+$/i;

/**
 * Sums each engine over its processes and keeps the busiest engine, the way
 * Task Manager reads the same counters. No engine at all is no reading, never an idle GPU.
 */
export function engineLoads(items: readonly Item[], pids: ReadonlySet<number>): { adapters: Map<string, number>; pids: Map<number, number> } | null {
  const engines = new Map<string, number>();
  const pidEngines = new Map<number, Map<string, number>>();
  for (const { name, value } of items) {
    const match = ENGINE.exec(name);
    if (match === null || !Number.isFinite(value)) continue;
    const luid = `${match[2]!.toLowerCase()}_${match[3]!.toLowerCase()}`;
    const engine = `${luid}/${match[4]}/${match[5]}`;
    engines.set(engine, (engines.get(engine) ?? 0) + value);
    const pid = Number(match[1]);
    if (!pids.has(pid)) continue;
    const own = pidEngines.get(pid) ?? new Map<string, number>();
    own.set(engine, (own.get(engine) ?? 0) + value);
    pidEngines.set(pid, own);
  }
  if (engines.size === 0) return null;
  const adapters = new Map<string, number>();
  for (const [engine, value] of engines) {
    const luid = engine.slice(0, engine.indexOf('/'));
    adapters.set(luid, Math.max(adapters.get(luid) ?? 0, Math.min(100, value)));
  }
  const byPid = new Map<number, number>();
  for (const pid of pids) byPid.set(pid, Math.min(100, Math.max(0, ...(pidEngines.get(pid)?.values() ?? []))));
  return { adapters, pids: byPid };
}

let query: GpuQuery | null = null;
let failed = false;
let adapters: { at: number; list: Adapter[] } | null = null;
let idle: ReturnType<typeof setTimeout> | undefined;

function closeLater(): void {
  clearTimeout(idle);
  idle = setTimeout(() => { query?.close(); query = null; }, IDLE_CLOSE_MS);
  (idle as { unref?: () => void }).unref?.();
}

/** Closes the PDH query now; the next read opens it again. */
export function releaseGpus(): void {
  clearTimeout(idle);
  query?.close();
  query = null;
}

export async function readGpus(pids: ReadonlySet<number>): Promise<{ gpus: MachineGpu[]; pids: Map<number, number> | null } | null> {
  if (failed) return null;
  try {
    if (adapters === null || Date.now() - adapters.at > ADAPTERS_TTL_MS) adapters = { at: Date.now(), list: enumerateAdapters() };
    if (adapters.list.length === 0) return { gpus: [], pids: null };
    if (query === null) {
      query = new GpuQuery();
      query.collect();
      await Bun.sleep(FIRST_INTERVAL_MS);
    }
    closeLater();
    if (!query.collect()) return { gpus: adapters.list.map(row => ({ name: row.name, percent: null, memoryUsedBytes: null, memoryTotalBytes: row.memoryTotalBytes || null })), pids: null };
    const loads = engineLoads(query.items('engine'), pids);
    const used = new Map<string, number>();
    for (const { name, value } of query.items('memory')) {
      const match = MEMORY.exec(name);
      if (match === null) continue;
      const luid = `${match[1]!.toLowerCase()}_${match[2]!.toLowerCase()}`;
      used.set(luid, (used.get(luid) ?? 0) + value);
    }
    return {
      gpus: adapters.list.map(row => ({
        name: row.name,
        percent: loads?.adapters.get(row.luid) ?? null,
        memoryUsedBytes: used.get(row.luid) ?? null,
        memoryTotalBytes: row.memoryTotalBytes || null,
      })),
      pids: loads?.pids ?? null,
    };
  } catch {
    // No dxgi.dll or pdh.dll (Server Core, a stripped image): say so once and stop trying.
    failed = true;
    releaseGpus();
    return null;
  }
}
