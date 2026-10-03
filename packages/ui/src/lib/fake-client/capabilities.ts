import { deriveThreadCapabilities, protocolSupportsSteering, threadActive } from '@boite/contracts';
import type { FakeContext, FakeMethods } from './context';

/** The fixture reports its implemented controls through the same pure mapping as the core. */
export function capabilityMethods(ctx: FakeContext): Pick<FakeMethods, 'threads.capabilities'> {
  return {
    'threads.capabilities': async ({ threadId }) => {
      const thread = ctx.thread(threadId);
      const provider = ctx.providers.find(item => item.id === thread.providerId);
      const account = ctx.accounts.find(item => item.id === thread.accountId);
      const protocol = provider?.protocol ?? null;
      const turn = thread.turns.findLast(item => item.status === 'running');
      const running = ctx.inFlight.get(threadId);
      const pendingApprovals = [...ctx.pendingPermissions.values()].some(item => item.request.threadId === threadId);
      const pendingQuestions = [...ctx.pendingQuestions.values()].filter(item => item.request.threadId === threadId);
      const steeringSupported = protocolSupportsSteering(protocol);
      const steeringReason = thread.status !== 'running' || !turn || !running || running.cancelled ? 'not-running'
        : turn.execution?.operation === 'compact' ? 'busy'
        : !steeringSupported ? 'unsupported'
        : (turn.execution?.selectionVersion ?? 0) !== (thread.selectionVersion ?? 0) ? 'selection-changed'
        : pendingApprovals || pendingQuestions.some(item => !item.request.async) ? 'awaiting-input' : null;
      return deriveThreadCapabilities({
        threadId, providerId: thread.providerId, protocol, selectionVersion: thread.selectionVersion ?? 0,
        providerCapabilities: provider?.capabilities ?? null,
        runtimeReason: !provider?.available ? 'provider-unavailable' : !account || account.providerId !== thread.providerId || account.status === 'unauthenticated' ? 'account-unavailable' : null,
        conversationReason: thread.agentSessionId || thread.projectId === null ? 'agent-session' : thread.archived ? 'archived' : null,
        busy: threadActive(thread.status) || Boolean(running), steeringSupported, steeringReason,
        compactionReason: !thread.sessionId ? 'no-session' : protocol === 'acp' && !thread.commands.some(command => command.name === 'compact') ? 'no-command' : protocol === 'agy' ? 'unsupported' : null,
        preparationSupported: protocol === 'claude-sdk' || protocol === 'codex-appserver',
        pendingApprovals, pendingQuestions: pendingQuestions.length > 0,
        hasForkHistory: thread.messages.some(message => message.state !== 'streaming'),
        hasRewindHistory: thread.messages.some(message => message.role === 'user'),
        // Fixture branching deliberately seeds history; it owns no native transcript.
        nativeForkSupported: false, nativeForkAvailable: false,
        nativeRewindSupported: false, nativeRewindAvailable: false,
        backgroundSupported: protocol === 'claude-sdk' || (thread.background?.length ?? 0) > 0,
      });
    },
  };
}
