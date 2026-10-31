import { RpcErrorCode, virtualDesktopCommandError, virtualDesktopSizeError } from '@boite/contracts';
import { RpcFailure } from '../client';
import { refusal } from './shared';
import type { FakeContext, FakeMethods } from './context';

type Methods = 'desktop.status' | 'desktop.start' | 'desktop.run' | 'desktop.stop';

/** The in-memory client runs no X server: it answers as a machine without the tools would, after the core's checks. */
const REASON = 'the in-memory client has no virtual desktop';

const invalid = (message: string, data: Record<string, unknown>) => new RpcFailure({ code: RpcErrorCode.InvalidParams, message, data });

export function desktopMethods(ctx: FakeContext): Pick<FakeMethods, Methods> {
  return {
    'desktop.status': async ({ threadId }) => {
      ctx.thread(threadId);
      return { support: { available: false, reason: REASON }, session: null };
    },
    'desktop.start': async ({ threadId, width, height }) => {
      const problem = virtualDesktopSizeError(width, height);
      if (problem) throw invalid(problem, { width, height });
      ctx.thread(threadId);
      throw refusal(`no virtual desktop on this machine: ${REASON}`, { threadId });
    },
    'desktop.run': async ({ threadId, command, cwd }) => {
      const problem = virtualDesktopCommandError(command);
      if (problem) throw invalid(problem, { field: 'command' });
      if (typeof cwd !== 'string' || !(cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cwd))) throw invalid('cwd: expected the absolute path of an existing folder', { field: 'cwd' });
      ctx.thread(threadId);
      throw refusal(`no virtual desktop on this machine: ${REASON}`, { threadId });
    },
    'desktop.stop': async ({ threadId }) => {
      ctx.thread(threadId);
      return { stopped: false };
    },
  };
}
