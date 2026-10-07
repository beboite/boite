import { deriveThreadCapabilities, protocolSupportsSteering, threadActive, type ThreadCapabilities, type ThreadCapabilityReason } from '@boite/contracts';
import type { Core } from '../core.ts';
import { assertDriverRunnable, getDriver } from '../drivers/index.ts';
import { userSteeringUnavailable } from './user-steering.ts';

/** Reads registered lazy wrappers and existing journal/runtime facts; never probes or prepares. */
export function threadCapabilities(core: Core, threadId: string): ThreadCapabilities {
  const thread = core.threads.require(threadId);
  const provider = core.providers.get(thread.providerId);
  const account = core.accounts.list().find(item => item.id === thread.accountId);
  const protocol = provider?.protocol ?? null;
  let runtimeReason: ThreadCapabilityReason | null = null;
  if (!provider) runtimeReason = 'provider-unavailable';
  else if (!core.providers.enabled(provider.id)) runtimeReason = 'provider-disabled';
  else if (!account || account.providerId !== thread.providerId) runtimeReason = 'account-unavailable';
  else {
    try { assertDriverRunnable(provider.protocol, core.providers.summary(provider.id), account); }
    catch { runtimeReason = account.status === 'unauthenticated' ? 'account-unavailable' : 'provider-unavailable'; }
  }
  if (core.stopping) runtimeReason = 'stopping';
  else if (core.updates.updating(thread.providerId)) runtimeReason = 'updating';
  else if (core.plugins.blocksAccount(thread.accountId)) runtimeReason = 'plugins-blocked';
  const conversationReason = thread.agentSessionId ? 'agent-session' : thread.archived ? 'archived' : null;
  const handle = core.threads.runner.handles.get(threadId);
  const active = thread.status === 'running' ? core.journal.db.query("SELECT id FROM turns WHERE thread_id = ? AND status = 'running' ORDER BY rowid DESC LIMIT 1").get(threadId) as { id: string } | null : null;
  const activeTurn = active ? core.journal.getTurn(active.id) : null;
  const steeringReason = userSteeringUnavailable(core, core.threads, threadId, activeTurn);
  // Only implemented handle methods prove steering. Idle known protocols describe their next runtime.
  const steeringSupported = Boolean(handle?.steerUser || handle?.steer) || protocolSupportsSteering(protocol);
  let compactionReason: ThreadCapabilityReason | null = null;
  if (provider) {
    const refusal = core.threads.compactRefusal(thread);
    if (refusal) compactionReason = !thread.sessionId ? 'no-session' : protocol === 'acp' ? 'no-command' : 'unsupported';
  }
  // Metadata existence checks must not decode old images or large tool output.
  const hasForkHistory = core.journal.db.query("SELECT 1 FROM messages WHERE thread_id = ? AND state != 'streaming' LIMIT 1").get(threadId) !== null;
  const hasRewindHistory = core.journal.db.query("SELECT 1 FROM messages WHERE thread_id = ? AND role = 'user' LIMIT 1").get(threadId) !== null;
  return deriveThreadCapabilities({
    threadId, providerId: thread.providerId, protocol, selectionVersion: thread.selectionVersion ?? 0,
    providerCapabilities: provider?.capabilities ?? null, runtimeReason,
    conversationReason: conversationReason ?? (thread.projectId === null ? 'agent-session' : null),
    busy: threadActive(thread.status) || Boolean(handle), steeringSupported, steeringReason, compactionReason,
    preparationSupported: protocol !== null && getDriver(protocol).prepare !== undefined,
    pendingApprovals: core.threads.listPermissions(threadId).length > 0,
    pendingQuestions: core.threads.listQuestions(threadId).length > 0,
    hasForkHistory, hasRewindHistory,
    nativeForkSupported: protocol === 'claude-sdk' || protocol === 'codex-appserver', nativeForkAvailable: (protocol === 'claude-sdk' || protocol === 'codex-appserver') && core.threads.branching.nativeForkAvailable(thread),
    nativeRewindSupported: protocol === 'claude-sdk' || protocol === 'codex-appserver', nativeRewindAvailable: (protocol === 'claude-sdk' || protocol === 'codex-appserver') && core.threads.branching.nativeRewindAvailable(thread),
    backgroundSupported: protocol === 'claude-sdk' || core.threads.agentState.background.has(threadId),
  });
}
