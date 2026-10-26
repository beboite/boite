import { spyOn } from 'bun:test';
import { AgentBrowser } from '../../src/browser.ts';
import { Cdp } from '../../src/browser/cdp.ts';

/** Observes native command/dialog/target ordering without page content or changing replies. */
export async function traceBrowserCommands<T>(body: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const records: Array<Record<string, unknown>> = [];
  const active = new Set<number>();
  const connections = new WeakMap<Cdp, { id: number; sessions: Map<string, number>; targets: Map<string, number> }>();
  const off: Array<() => void> = [];
  let operation = 0, click = 0, connection = 0, transmission = 0, dropped = 0;
  const originalCommand = AgentBrowser.prototype.command;
  const originalSend = Cdp.prototype.send;

  const record = (data: Record<string, unknown>): void => {
    if (records.length === 512) { records.shift(); dropped++; }
    records.push({ ms: Math.round((performance.now() - started) * 100) / 100, active: [...active], ...data });
  };
  // Error messages can contain URLs, selectors or evaluated code. Keep only a fixed category.
  const errorKind = (error: unknown): string => {
    const message = error instanceof Error ? error.message : '';
    if (/closed/i.test(message)) return 'closed';
    if (/within|timed out|timeout|does not answer|did not answer/i.test(message)) return 'deadline';
    return 'rejected';
  };
  const identify = (cdp: Cdp, session?: string): { connection: number; session: number | null } => {
    let state = connections.get(cdp);
    if (!state) {
      state = { id: ++connection, sessions: new Map(), targets: new Map() };
      connections.set(cdp, state);
      off.push(cdp.on('Page.javascriptDialogOpening', (params, sessionId) => {
        const type = ['alert', 'confirm', 'prompt', 'beforeunload'].includes(String(params.type)) ? params.type : 'other';
        record({ event: 'dialog-opening', ...identify(cdp, sessionId), type });
      }));
      off.push(cdp.on('Page.javascriptDialogClosed', (params, sessionId) => {
        record({ event: 'dialog-closed', ...identify(cdp, sessionId), result: params.result === true });
      }));
      for (const method of ['Target.targetCreated', 'Target.targetInfoChanged', 'Target.targetDestroyed', 'Target.attachedToTarget', 'Target.detachedFromTarget']) {
        off.push(cdp.on(method, (params, sessionId) => {
          const info = params.targetInfo as { targetId?: unknown; openerId?: unknown } | undefined;
          record({ event: method, ...identify(cdp, sessionId),
            ...target(cdp, info?.targetId ?? params.targetId),
            ...(typeof info?.openerId === 'string' ? { opener: target(cdp, info.openerId).target } : {}),
            ...(typeof params.sessionId === 'string' ? { targetSession: identify(cdp, params.sessionId).session } : {}),
          });
        }));
      }
    }
    if (session !== undefined && !state.sessions.has(session)) state.sessions.set(session, state.sessions.size + 1);
    return { connection: state.id, session: session === undefined ? null : state.sessions.get(session)! };
  };
  const target = (cdp: Cdp, id: unknown): { target?: number } => {
    if (typeof id !== 'string') return {};
    const state = connections.get(cdp)!;
    if (!state.targets.has(id)) state.targets.set(id, state.targets.size + 1);
    return { target: state.targets.get(id)! };
  };

  const commandSpy = spyOn(AgentBrowser.prototype, 'command').mockImplementation(function (this: AgentBrowser, params) {
    const id = ++operation;
    active.add(id);
    const selector = 'selector' in params.action ? params.action.selector : undefined;
    record({ event: 'operation-start', operation: id, kind: params.action.kind,
      ...(params.action.kind === 'click' ? { click: ++click } : {}),
      ...(typeof selector === 'string' && /^@e\d+$/.test(selector) ? { ref: selector } : {}),
    });
    const failed = (error: unknown): never => {
      record({ event: 'operation-error', operation: id, error: errorKind(error) });
      active.delete(id);
      throw error;
    };
    try {
      return originalCommand.call(this, params).then(reply => {
        const value = reply.value as { dialogs?: Array<{ accepted?: boolean }>; loading?: boolean; navigated?: boolean } | undefined;
        record({ event: 'operation-end', operation: id,
          ...(Array.isArray(value?.dialogs) ? { reportedDialogs: value.dialogs.map(dialog => ({ accepted: dialog.accepted === true })) } : {}),
          ...(typeof value?.loading === 'boolean' ? { loading: value.loading } : {}),
          ...(typeof value?.navigated === 'boolean' ? { navigated: value.navigated } : {}),
        });
        active.delete(id);
        return reply;
      }, failed);
    } catch (error) { return failed(error); }
  });
  const sendSpy = spyOn(Cdp.prototype, 'send').mockImplementation(function <R = Record<string, unknown>>(this: Cdp, method: string, params: Record<string, unknown> = {}, session?: string, timeoutMs?: number): Promise<R> {
    const identity = identify(this, session);
    const id = ++transmission;
    const name = /^[A-Za-z]+\.[A-Za-z]+$/.test(method) && method.length <= 80 ? method : 'other';
    record({ event: 'cdp-send', transmission: id, ...identity, method: name,
      ...target(this, params.targetId),
      ...(method === 'Input.dispatchMouseEvent' ? { mouseType: ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].includes(String(params.type)) ? params.type : 'other' } : {}),
      ...(method === 'Page.handleJavaScriptDialog' ? { accept: params.accept === true } : {}),
    });
    return (originalSend.call(this, method, params, session, timeoutMs) as Promise<R>).then(reply => {
      const value = reply as { targetId?: unknown; sessionId?: unknown };
      record({ event: 'cdp-ack', transmission: id, ...identity, method: name,
        ...target(this, value.targetId),
        ...(typeof value.sessionId === 'string' ? { targetSession: identify(this, value.sessionId).session } : {}),
      });
      return reply;
    }, error => {
      record({ event: 'cdp-error', transmission: id, ...identity, method: name, error: errorKind(error) });
      throw error;
    });
  });

  try { return await body(); }
  catch (error) {
    console.error('BROWSER_COMMAND_TRACE ' + JSON.stringify({ dropped, records }));
    throw error;
  } finally {
    commandSpy.mockRestore();
    sendSpy.mockRestore();
    for (const unsubscribe of off) unsubscribe();
  }
}
