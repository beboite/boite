/** The fake shells a thread or a sign-in opens. */
import { MAX_THREAD_TERMINALS, RpcErrorCode, THREAD_TERMINAL_KEY, isThreadTerminal, threadTerminalId, type ThreadId } from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';

/** The shell goes; a sign-in one leaves its account signed in, as the real CLI would. */
export function closeTerminal(ctx: FakeContext, id: string): void {
  if (!ctx.terminals.delete(id)) return;
  ctx.emit('terminal.exited', { id, exitCode: 0 });
  if (!id.startsWith('login:')) return;
  const account = ctx.accounts.find((a) => `login:${a.id}` === id);
  if (!account) return;
  account.status = 'ok';
  account.identity = 'you@example.com';
  ctx.emit('accounts.updated', structuredClone(account));
}

/** Every shell of the thread goes, as the core's `closeThread` does on archive. */
export function closeThreadTerminals(ctx: FakeContext, threadId: ThreadId): void {
  for (const id of [...ctx.terminals.keys()]) if (isThreadTerminal(threadId, id)) closeTerminal(ctx, id);
}

export function terminalMethods(ctx: FakeContext) {
  return {
    'terminals.open': async (params) => {
      const thread = ctx.threads.get(params.threadId);
      if (!thread) throw ctx.notFound('thread', params.threadId);
      if (params.terminalId !== undefined && !THREAD_TERMINAL_KEY.test(params.terminalId)) {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `terminalId must be term-2 to term-${MAX_THREAD_TERMINALS}, not ${JSON.stringify(params.terminalId)}`, data: { field: 'terminalId', expected: `term-2 to term-${MAX_THREAD_TERMINALS}` } });
      }
      const id = threadTerminalId(thread.id, params.terminalId);
      if (!ctx.terminals.has(id)) ctx.terminals.set(id, { cwd: thread.cwd, output: `PS ${thread.cwd}> `, line: '' });
      const shell = ctx.terminals.get(id)!;
      return { id, cwd: shell.cwd, output: shell.output, sequence: shell.sequence ?? 0 };
    },
    'terminals.list': async (params) => {
      const thread = ctx.threads.get(params.threadId);
      if (!thread) throw ctx.notFound('thread', params.threadId);
      const first = threadTerminalId(thread.id);
      return [...ctx.terminals].filter(([id]) => isThreadTerminal(thread.id, id)).map(([id, shell]) => ({
        id,
        ...(id === first ? {} : { terminalId: id.slice(first.length + 1) }),
        cwd: shell.cwd,
      }));
    },
    'terminals.write': async (params) => {
      const shell = ctx.terminals.get(params.id);
      if (!shell) throw ctx.notFound('terminal', params.id);
      let echo = '';
      for (const char of params.data) {
        if (char === '\r') {
          const typed = shell.line.trim();
          shell.line = '';
          if (typed === 'exit') {
            closeTerminal(ctx, params.id);
            return { ok: true };
          }
          echo += `\r\n${typed.length > 0 ? `${typed}\r\n` : ''}PS ${shell.cwd}> `;
        } else if (char === '\x7f') {
          if (shell.line.length > 0) { shell.line = shell.line.slice(0, -1); echo += '\b \b'; }
        } else if (char >= ' ') {
          shell.line += char;
          echo += char;
        }
      }
      shell.output += echo;
      if (echo.length > 0) {
        shell.sequence = (shell.sequence ?? 0) + 1;
        ctx.emit('terminal.output', { id: params.id, data: echo, sequence: shell.sequence });
      }
      return { ok: true };
    },
    'terminals.resize': async (params) => {
      if (!ctx.terminals.has(params.id)) throw ctx.notFound('terminal', params.id);
      return { ok: true };
    },
    'terminals.close': async (params) => {
      closeTerminal(ctx, params.id);
      return { ok: true };
    },
  } satisfies Partial<FakeMethods>;
}
