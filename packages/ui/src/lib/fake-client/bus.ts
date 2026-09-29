/** The socket's side of the fake: its state, the event handlers, thread subscriptions and the calls it holds. */
import { DEVICE_EVENTS, RpcErrorCode, type Principal, type RpcEventName, type RpcEvents, type ThreadId } from '@boite/contracts';
import { RpcFailure, droppedFailure, type ClientState, type EventHandler } from '../client';

export class FakeBus {
  state: ClientState = 'idle';
  readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
  readonly stateHandlers = new Set<(state: ClientState) => void>();
  /** What the core has this socket subscribed to: what `emitToThread` reads. */
  readonly subscribed = new Set<ThreadId>();
  /** `WsClient.#subscribed`'s mirror: the ids the client itself puts back after a reconnect. */
  readonly clientSubscribed = new Set<ThreadId>();
  /** The calls the socket is holding, so `drop()` can reject them from underneath. */
  readonly pending = new Set<{ reject: (error: RpcFailure) => void }>();

  constructor(public principal: Principal) {}

  onState(handler: (state: ClientState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  on<E extends RpcEventName>(event: E, handler: EventHandler<E>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    const erased = handler as (payload: unknown) => void;
    set.add(erased);
    return () => {
      set.delete(erased);
    };
  }

  setState(state: ClientState): void {
    if (this.state === state) return;
    this.state = state;
    for (const handler of this.stateHandlers) handler(state);
  }

  /** What reaches the app's handlers once the core has emitted an event. */
  deliver<E extends RpcEventName>(event: E, payload: RpcEvents[E]): void {
    // A socket that is down carries nothing. Everything the core emitted
    // during the gap is lost, which is what `reload()` exists to repair.
    if (this.state !== 'ready') return;
    // The core's `mayReceiveEvent`: a paired device hears only the device events.
    if (this.principal === 'session' && !DEVICE_EVENTS.has(event)) return;
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) handler(payload);
  }

  /**
   * One call the socket holds. A reply that lands after `drop()` broke the
   * promise is thrown away rather than settling it twice, which is what
   * `WsClient` gets for free by clearing `#pending` before it rejects.
   */
  hold<T>(answer: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry = { reject };
      this.pending.add(entry);
      answer.then(
        (value) => {
          if (this.pending.delete(entry)) resolve(value);
        },
        (error: unknown) => {
          if (this.pending.delete(entry)) reject(error);
        }
      );
    });
  }

  dropPending(message: string, dropped = false): void {
    const pending = [...this.pending];
    this.pending.clear();
    for (const entry of pending) {
      entry.reject(dropped ? droppedFailure(message) : new RpcFailure({ code: RpcErrorCode.Internal, message }));
    }
  }
}
