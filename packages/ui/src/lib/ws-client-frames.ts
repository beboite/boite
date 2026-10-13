// Owns RPC reply and event decoding, including chunked answer assembly.
import { RPC_CHUNK_MARK, RpcErrorCode, type RpcMethodName } from '@boite/contracts';
import { RpcFailure } from './rpc-error';

export interface Pending {
  /** A `hello` sent on a ready socket is a liveness probe, not a caller's request. */
  method: RpcMethodName;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  /** Each slice that lands restarts the call's clock: an answer still arriving is not a dead socket. */
  touch: () => void;
  onProgress?: (received: number, total: number) => void;
  /** The slices of a chunked answer received so far, and their bytes. */
  slices?: string[];
  received?: number;
}

/** The header of a chunk frame, or null when `raw` is not one. */
function chunkHeader(raw: string): { id: number; bytes: number; total: number; body: number } | null {
  if (!raw.startsWith(RPC_CHUNK_MARK)) return null;
  const end = raw.indexOf('\n');
  if (end < 0) return null;
  try {
    const header = JSON.parse(raw.slice(RPC_CHUNK_MARK.length, end)) as Record<string, unknown>;
    const { id, bytes, total } = header;
    if (typeof id !== 'number' || typeof bytes !== 'number' || typeof total !== 'number') return null;
    return { id, bytes, total, body: end + 1 };
  } catch {
    return null;
  }
}

export function receiveFrame(
  raw: unknown,
  pendingCalls: Map<number, Pending>,
  handlers: Map<string, Set<(payload: unknown) => void>>,
  receiveWhole: (raw: string) => void
): void {
  if (typeof raw !== 'string') return;
  const chunk = chunkHeader(raw);
  if (chunk) {
    receiveChunk(chunk, raw, pendingCalls, receiveWhole);
    return;
  }
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof frame !== 'object' || frame === null) return;
  const record = frame as Record<string, unknown>;

  if (typeof record['id'] === 'number') {
    const pending = pendingCalls.get(record['id']);
    if (!pending) return;
    pendingCalls.delete(record['id']);
    const error = record['error'];
    if (error && typeof error === 'object') {
      const shape = error as Record<string, unknown>;
      pending.reject(
        new RpcFailure({
          code: typeof shape['code'] === 'number' ? shape['code'] : RpcErrorCode.Internal,
          message: typeof shape['message'] === 'string' ? shape['message'] : 'unknown error',
          data: shape['data']
        })
      );
      return;
    }
    pending.resolve(record['result']);
    return;
  }

  const method = record['method'];
  if (typeof method !== 'string') return;
  const set = handlers.get(method);
  if (!set) return;
  for (const handler of [...set]) handler(record['params']);
}

/**
 * One slice of an answer: counted, kept, and once the last one landed the
 * joined text returns to the client as the frame the core would have sent
 * whole. A slice for a call nobody waits for any more is dropped.
 */
function receiveChunk(
  chunk: { id: number; bytes: number; total: number; body: number },
  raw: string,
  pendingCalls: Map<number, Pending>,
  receiveWhole: (raw: string) => void
): void {
  const pending = pendingCalls.get(chunk.id);
  if (!pending) return;
  pending.touch();
  (pending.slices ??= []).push(raw.slice(chunk.body));
  pending.received = (pending.received ?? 0) + chunk.bytes;
  pending.onProgress?.(Math.min(pending.received, chunk.total), chunk.total);
  if (pending.received < chunk.total) return;
  const whole = pending.slices.join('');
  delete pending.slices;
  receiveWhole(whole);
}
