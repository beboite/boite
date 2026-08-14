/**
 * One supervisor per environment, and the only thing in the app allowed to
 * decide that a connection should be tried again.
 *
 * Nothing here touches a socket, a timer or a store: every method answers with
 * the effects its owner must perform. That is what makes the whole retry policy
 * testable without a WebSocket, and it is why the runtime (`runtime.svelte.ts`)
 * is a thin shell around it.
 *
 * Two rules the shape exists to enforce:
 *
 * - `connected` means the socket is open **and** the initial config round trip
 *   came back. A socket that opened and then never answered `hello` is a boite
 *   that cannot serve anything, and calling that connected is what made the
 *   chrome say a machine was up while every call on it timed out.
 * - Sync status is not connection status. A projection restored from cache and a
 *   projection just read off a live socket are different claims about the same
 *   rows, and during a fast reconnect they race.
 */

export type ConnectionPhase =
  | "idle"
  | "connecting"
  | "handshaking"
  | "connected"
  | "waiting"
  | "offline"
  | "blocked";

/**
 * Why a supervisor stopped on its own. Both mean the boite answered something
 * definite, so retrying on a timer is spinning: only an external event (a new
 * credential, the user pressing retry, the network coming back for `config`)
 * can change the answer.
 */
export type BlockReason = "auth" | "config";

export type SyncStatus = "empty" | "cached" | "synchronizing" | "live";

export type Effect =
  | { kind: "dial" }
  | { kind: "release" }
  | { kind: "probe" }
  | { kind: "schedule"; delayMs: number }
  | { kind: "cancel" };

export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 16_000;
/** How long a connection has to hold before the next drop starts from scratch. */
export const STABLE_RESET_MS = 30_000;
/**
 * Past this, a foreground is not a resume. Under it the socket is probed,
 * because a phone that was away for ten seconds almost always still has one and
 * replacing it costs a full scrollback replay per attached thread.
 */
export const LONG_SUSPENSION_MS = 60_000;

export interface SupervisorDeps {
  now(): number;
  random(): number;
}

type LoadSource = "cache" | "live";

interface Load {
  source: LoadSource;
  generation: number;
  seq: number;
}

export class EnvironmentSupervisor {
  readonly id: string;

  #deps: SupervisorDeps;
  #phase: ConnectionPhase = "idle";
  #blocked: BlockReason | null = null;
  #wanted = false;
  #online = true;
  #backoff = BACKOFF_MIN_MS;
  #attempts = 0;
  #connectedAt: number | null = null;
  #generation = 0;

  #sync: SyncStatus = "empty";
  #loads = new Map<number, Load>();
  #loadSeq = 0;
  #liveAcceptedSeq: number | null = null;

  constructor(id: string, deps: Partial<SupervisorDeps> = {}) {
    this.id = id;
    this.#deps = {
      now: deps.now ?? (() => Date.now()),
      random: deps.random ?? Math.random,
    };
  }

  get phase(): ConnectionPhase {
    return this.#phase;
  }

  get blockedReason(): BlockReason | null {
    return this.#blocked;
  }

  get sync(): SyncStatus {
    return this.#sync;
  }

  /** Consecutive failed dials since the last stable connection. */
  get attempts(): number {
    return this.#attempts;
  }

  /** Which dial a reply belongs to. A live answer from an older one is stale. */
  get generation(): number {
    return this.#generation;
  }

  get isConnected(): boolean {
    return this.#phase === "connected";
  }

  get wanted(): boolean {
    return this.#wanted;
  }

  start(): Effect[] {
    this.#wanted = true;
    if (this.#phase === "connected" || this.#phase === "handshaking") return [];
    if (this.#blocked) return [];
    if (!this.#online) {
      this.#phase = "offline";
      return [];
    }
    return this.#dial();
  }

  /** No longer wanted up. Keeps whatever was read as a cached projection. */
  stop(): Effect[] {
    this.#wanted = false;
    this.#phase = "idle";
    this.#connectedAt = null;
    this.#demoteSync();
    return [{ kind: "cancel" }, { kind: "release" }];
  }

  socketOpened(): Effect[] {
    if (!this.#wanted) return [];
    this.#phase = "handshaking";
    return [];
  }

  configSucceeded(): Effect[] {
    if (!this.#wanted) return [];
    this.#phase = "connected";
    this.#blocked = null;
    this.#connectedAt = this.#deps.now();
    this.#attempts = 0;
    return [];
  }

  /**
   * The socket opened and the boite would not describe itself. Blocked rather
   * than retried: a server answering a handshake with an error answers the next
   * one the same way, and a per-environment loop doing that is N sockets a
   * second against a machine that is already unhappy.
   */
  configFailed(): Effect[] {
    this.#phase = "blocked";
    this.#blocked = "config";
    this.#connectedAt = null;
    this.#demoteSync();
    return [{ kind: "cancel" }, { kind: "release" }];
  }

  authRejected(): Effect[] {
    this.#phase = "blocked";
    this.#blocked = "auth";
    this.#connectedAt = null;
    this.#demoteSync();
    return [{ kind: "cancel" }, { kind: "release" }];
  }

  /** The socket died, or a dial never reached the boite. */
  connectionLost(): Effect[] {
    if (!this.#wanted || this.#blocked) return [];
    this.#demoteSync();
    if (!this.#online) {
      this.#phase = "offline";
      this.#connectedAt = null;
      return [{ kind: "cancel" }, { kind: "release" }];
    }
    // Measured here rather than on a timer while connected: the two are
    // observably identical and this one costs no per-environment interval,
    // which with several environments live is the whole difference.
    if (this.#connectedAt !== null && this.#deps.now() - this.#connectedAt >= STABLE_RESET_MS) {
      this.#backoff = BACKOFF_MIN_MS;
      this.#attempts = 0;
    }
    this.#connectedAt = null;
    this.#attempts++;
    const delayMs = this.#nextDelay();
    this.#phase = "waiting";
    return [{ kind: "release" }, { kind: "schedule", delayMs }];
  }

  /** The scheduled retry came due. */
  timerFired(): Effect[] {
    if (!this.#wanted || this.#blocked) return [];
    if (!this.#online) {
      this.#phase = "offline";
      return [];
    }
    return this.#dial();
  }

  /**
   * The device lost the network. The session is released and no retry is
   * scheduled, so a laptop shut for a night wakes with its backoff untouched
   * instead of at the ceiling.
   */
  networkOffline(): Effect[] {
    this.#online = false;
    if (this.#phase === "offline") return [];
    this.#connectedAt = null;
    this.#demoteSync();
    if (this.#blocked) return [{ kind: "cancel" }, { kind: "release" }];
    this.#phase = "offline";
    return [{ kind: "cancel" }, { kind: "release" }];
  }

  networkOnline(): Effect[] {
    if (this.#online) return [];
    this.#online = true;
    // A credential the boite already refused will be refused again, so the
    // network coming back is not news for that one.
    if (this.#blocked === "auth") return [];
    this.#blocked = null;
    if (!this.#wanted) return [];
    this.#backoff = BACKOFF_MIN_MS;
    this.#attempts = 0;
    return this.#dial();
  }

  /**
   * The app came back to the foreground after `suspendedForMs`. A connection
   * believed live is asked whether it still is; only a suspension long enough
   * that a socket cannot plausibly have survived it is replaced outright.
   */
  foregrounded(suspendedForMs: number): Effect[] {
    if (this.#phase !== "connected") return [];
    if (suspendedForMs >= LONG_SUSPENSION_MS) {
      this.#connectedAt = null;
      this.#demoteSync();
      return [{ kind: "release" }, ...this.#dial()];
    }
    return [{ kind: "probe" }];
  }

  probeSucceeded(): Effect[] {
    return [];
  }

  probeFailed(): Effect[] {
    return this.connectionLost();
  }

  /** The user pressed retry. Clears any block and jumps the backoff queue. */
  wake(): Effect[] {
    this.#blocked = null;
    this.#wanted = true;
    if (this.#phase === "connected" || this.#phase === "handshaking") return [];
    this.#backoff = BACKOFF_MIN_MS;
    this.#attempts = 0;
    if (!this.#online) {
      this.#phase = "offline";
      return [{ kind: "cancel" }];
    }
    return [{ kind: "cancel" }, ...this.#dial()];
  }

  /**
   * A new credential arrived for this environment. The seam a per-environment
   * pairing slots into: whatever mints the credential calls this and the
   * supervisor stops being blocked without anything else knowing why.
   */
  credentialsChanged(): Effect[] {
    return this.wake();
  }

  // ---- sync tracking -----------------------------------------------------

  /**
   * Announce a projection read. The token is what says, when the read finally
   * lands, whether it is still allowed to be written.
   */
  beginLoad(source: LoadSource): number {
    const seq = ++this.#loadSeq;
    this.#loads.set(seq, { source, generation: this.#generation, seq });
    if (source === "live") this.#sync = "synchronizing";
    return seq;
  }

  /**
   * Whether the projection behind `token` may be written.
   *
   * A cached projection is only ever a cold-start filler: the cache is written
   * from live data, so it can never be newer than any live data that has
   * already landed. That is the whole guard against a slow cache read resolving
   * after a fast reconnect and painting stale rows over fresh ones.
   */
  acceptLoad(token: number): boolean {
    const entry = this.#loads.get(token);
    if (!entry) return false;
    this.#loads.delete(token);
    if (entry.source === "live") {
      if (entry.generation !== this.#generation) return false;
      if (this.#liveAcceptedSeq !== null && entry.seq < this.#liveAcceptedSeq) return false;
      this.#liveAcceptedSeq = entry.seq;
      this.#sync = "live";
      return true;
    }
    if (this.#liveAcceptedSeq !== null) return false;
    if (this.#sync !== "empty") return false;
    this.#sync = "cached";
    return true;
  }

  /** The read failed or was abandoned. */
  failLoad(token: number): void {
    const entry = this.#loads.get(token);
    if (!entry) return;
    this.#loads.delete(entry.seq);
    if (entry.source === "live" && this.#sync === "synchronizing") this.#demoteSync();
  }

  #dial(): Effect[] {
    this.#generation++;
    this.#phase = "connecting";
    return [{ kind: "dial" }];
  }

  #nextDelay(): number {
    const base = Math.min(this.#backoff, BACKOFF_MAX_MS);
    this.#backoff = Math.min(this.#backoff * 2, BACKOFF_MAX_MS);
    return Math.round(base * (0.5 + this.#deps.random() * 0.5));
  }

  #demoteSync(): void {
    this.#sync = this.#liveAcceptedSeq !== null ? "cached" : "empty";
  }
}
