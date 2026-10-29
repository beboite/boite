/*
 * How one tab reaches the documents of frames from other origins, which the
 * page kit cannot read from its parent. A frame of the same site runs in the
 * page's renderer, in an execution context of its own on the tab's session; a
 * frame of another site runs in a process of its own, a target that a command
 * attaches to and leaves when it ends. The kit's state lives in each frame's
 * window, so its refs outlast the session that read them.
 */
import type { Cdp } from './cdp.ts';
import type { FrameChannel, PageFrames } from './automation.ts';

type Subscribe = (method: string, listener: (params: Record<string, unknown>) => void) => void;

/** `on` subscribes to an event of the tab's own session, for as long as the tab lives. */
export function pageFrames(cdp: Cdp, sessionId: string, on: Subscribe): PageFrames {
  /** Each session's frames, by id, with the context their own document runs in. */
  const contexts = new Map<string, Map<string, number>>();
  const watch = (session: string, subscribe: Subscribe) => {
    const frames = new Map<string, number>();
    contexts.set(session, frames);
    subscribe('Runtime.executionContextCreated', params => {
      const context = params.context as { id: number; auxData?: { frameId?: string; isDefault?: boolean } };
      if (context.auxData?.isDefault && context.auxData.frameId) frames.set(context.auxData.frameId, context.id);
    });
    // The desktop app does not relay this one: a context it left behind fails its next evaluation, and the frame reads as gone.
    subscribe('Runtime.executionContextDestroyed', params => { for (const [frame, id] of frames) if (id === params.executionContextId) frames.delete(frame); });
    subscribe('Runtime.executionContextsCleared', () => frames.clear());
  };
  watch(sessionId, on);
  const opened = new Map<string, Array<() => void>>();
  const channel = (session: string, contextId?: number): FrameChannel => ({
    session, ...(contextId === undefined ? {} : { contextId }),
    send: (method, params = {}, timeoutMs) => cdp.send(method, params, session, timeoutMs),
  });
  return {
    async reach(parent, frameId) {
      const session = parent.session ?? sessionId;
      const contextId = contexts.get(session)?.get(frameId);
      if (contextId !== undefined) return channel(session, contextId);
      // A frame of another site is a target whose id is the frame's.
      const attached = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: frameId, flatten: true }).catch(() => null);
      if (!attached) return null;
      const child = attached.sessionId, offs: Array<() => void> = [];
      opened.set(child, offs);
      // Its own frames of the same site are contexts on its session, listed as soon as the runtime is enabled.
      watch(child, (method, listener) => offs.push(cdp.on(method, (params, from) => { if (from === child) listener(params); })));
      await cdp.send('Runtime.enable', {}, child).catch(() => {});
      return channel(child);
    },
    release() {
      for (const [session, offs] of opened) {
        for (const off of offs) off();
        contexts.delete(session);
        void cdp.send('Target.detachFromTarget', { sessionId: session }).catch(() => {});
      }
      opened.clear();
    },
  };
}
