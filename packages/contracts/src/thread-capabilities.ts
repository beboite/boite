import type { Protocol, ProviderCapabilities, ProviderId, ThreadCapabilities, ThreadCapability, ThreadCapabilityReason, ThreadId } from './index.ts';

/** Observed facts only. Gathering them must neither load a driver nor start a process. */
export interface ThreadCapabilitySnapshot {
  threadId: ThreadId;
  providerId: ProviderId;
  protocol: Protocol | null;
  selectionVersion: number;
  providerCapabilities: ProviderCapabilities | null;
  runtimeReason: ThreadCapabilityReason | null;
  conversationReason: ThreadCapabilityReason | null;
  busy: boolean;
  steeringSupported: boolean;
  steeringReason: ThreadCapabilityReason | null;
  compactionReason: ThreadCapabilityReason | null;
  preparationSupported: boolean;
  pendingApprovals: boolean;
  pendingQuestions: boolean;
  hasForkHistory: boolean;
  hasRewindHistory: boolean;
  nativeForkSupported: boolean;
  nativeForkAvailable: boolean;
  nativeRewindSupported: boolean;
  nativeRewindAvailable: boolean;
  backgroundSupported: boolean;
}

export function deriveThreadCapabilities(s: ThreadCapabilitySnapshot): ThreadCapabilities {
  const capability = (supported: boolean, reason: ThreadCapabilityReason | null): ThreadCapability => ({
    supported, available: supported && reason === null, reason: supported ? reason : 'unsupported',
  });
  const idle = s.runtimeReason ?? s.conversationReason ?? (s.busy ? 'busy' : null);
  const fork = s.conversationReason === 'archived' ? s.runtimeReason : s.runtimeReason ?? s.conversationReason;
  const forkReason = fork ?? (s.hasForkHistory ? null : 'no-history');
  const rewindReason = s.conversationReason ?? (s.busy ? 'busy' : null) ?? (s.hasRewindHistory ? null : 'no-history');
  const known = s.protocol !== null;
  return {
    threadId: s.threadId, providerId: s.providerId, protocol: s.protocol, selectionVersion: s.selectionVersion,
    steering: capability(s.steeringSupported, s.runtimeReason ?? s.conversationReason ?? s.steeringReason),
    compaction: capability(known && s.protocol !== 'agy', idle ?? s.compactionReason),
    images: capability(s.providerCapabilities?.images === true, s.steeringReason === null ? s.runtimeReason ?? s.conversationReason : idle),
    plan: capability(s.providerCapabilities?.planMode === true, idle),
    approvals: capability(s.providerCapabilities?.approvals === true, s.pendingApprovals ? null : 'no-request'),
    // Boite also accepts asynchronous question cards through its scoped CLI, independently of native questions.
    questions: capability(known, s.pendingQuestions ? null : 'no-request'),
    fork: { seeded: capability(known, forkReason), native: capability(s.nativeForkSupported, forkReason ?? (s.nativeForkAvailable ? null : 'no-checkpoint')) },
    rewind: { seeded: capability(known, rewindReason), native: capability(s.nativeRewindSupported, rewindReason ?? (s.nativeRewindAvailable ? null : 'no-checkpoint')) },
    sessionPreparation: capability(s.preparationSupported, idle),
    backgroundObservations: capability(s.backgroundSupported, null),
  };
}
