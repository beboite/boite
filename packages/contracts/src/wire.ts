import type { ThreadId } from './ids';
import type { RpcEventName, RpcEvents, RpcMethodName, RpcParams, RpcResult } from './index';
import type { PairingRole } from './pairing';
import type { ThreadSummary } from './threads';

// ---------------------------------------------------------------------------
// Wire frames: JSON-RPC 2.0 over one WebSocket, one JSON object per frame.
// ---------------------------------------------------------------------------

export interface RpcRequest<M extends RpcMethodName = RpcMethodName> {
  jsonrpc: '2.0';
  id: number | string;
  method: M;
  params: RpcParams<M>;
  /**
   * The client counts what it has received of this answer: one longer than
   * `RPC_CHUNK_BYTES` then comes as chunk frames (`RPC_CHUNK_MARK`). A core
   * without `features.chunkedAnswers` ignores the key and answers in one frame.
   */
  progress?: true;
}

/**
 * The first character of a chunk frame. A text frame that starts with it is
 * not JSON: it is one slice of an answer to a request that asked for
 * `progress`, as `\u001e{"id":7,"bytes":65536,"total":3400000}\n<slice>`. The
 * slices of one answer go out in order, and every other frame the core writes
 * meanwhile waits behind them; joined, they are the response frame the core
 * would have sent whole. `bytes` is the UTF-8 size of this slice and `total`
 * that of the whole frame, so a client shows how much of the answer it holds
 * without decoding anything twice.
 */
export const RPC_CHUNK_MARK = '\u001e';
/** Answers above this many UTF-8 bytes go out as chunk frames of about this size, to a request that asked for `progress`. */
export const RPC_CHUNK_BYTES = 64 * 1024;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponse<M extends RpcMethodName = RpcMethodName> {
  jsonrpc: '2.0';
  id: number | string;
  result?: RpcResult<M>;
  error?: RpcError;
}

export interface RpcNotification<E extends RpcEventName = RpcEventName> {
  jsonrpc: '2.0';
  method: E;
  params: RpcEvents[E];
}

export type RpcFrame = RpcRequest | RpcResponse | RpcNotification;

export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  /** `hello` missing, late, or with a wrong token. The socket closes after this. */
  Unauthorized: -32001,
  NotFound: -32004,
  /** A refused descriptor, a refused path, a refused origin. Never silent. */
  Refused: -32010,
  /** The provider or account cannot run right now (unauthenticated, missing binary). */
  Unavailable: -32011,
} as const;

/**
 * The `data` of the Refused error `turns.start` answers while the thread
 * already has a turn queued or running, often one the core opened by itself
 * (held answers to asynchronous questions, an agent resuming on its own). The
 * prompt is not wrong, only early: `thread` is the row as the core has it, and
 * a client keeps the prompt until that turn is over.
 */
export interface TurnInFlightData {
  threadId: ThreadId;
  reason: 'turn-in-flight';
  thread: ThreadSummary;
}

/** WebSocket close codes the core uses. */
export const RpcCloseCode = {
  Unauthorized: 4001,
  BadOrigin: 4003,
  ProtocolMismatch: 4010,
} as const;

/** Path of the RPC WebSocket on the core's HTTP server. */
export const RPC_PATH = '/rpc';

/** Query parameter that carries a token when a UI is opened on one by hand. */
export const PAIR_QUERY_PARAM = 'token';
/** Query parameter that carries the one-time grant of a pairing link. */
export const GRANT_QUERY_PARAM = 'grant';
/** How long a pairing grant can wait to be opened. */
export const GRANT_TTL_MS = 10 * 60 * 1000;
/** Every role `pairing.grant` takes; anything else is refused by name. */
export const PAIRING_ROLES: readonly PairingRole[] = ['device', 'owner'];
/**
 * What a client says it is in its `hello`. `plugin` is a desktop-app plugin
 * (`provides.desktopApp`) talking to the core that started it: it signs in
 * with the owner token but is neither Boite's desktop app nor its web app, so
 * its prompts carry no origin note and it cannot host the agent browser.
 */
export const CLIENT_NAMES = ['shell', 'pwa', 'cli', 'plugin', 'test', 'bench'] as const;
export type ClientName = (typeof CLIENT_NAMES)[number];

/** What a hello's `accepts` may name. Anything else is ignored. */
export const HELLO_ACCEPTED = ['thread.load'] as const;
export type HelloAccepted = (typeof HELLO_ACCEPTED)[number];
