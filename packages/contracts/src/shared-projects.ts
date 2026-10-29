import type { AgentAddress, AgentContact, AgentLetter, AgentMatch, AgentTranscript } from './coordination';
import type { AccountId, ProjectId, ProviderId, ThreadId, Timestamp } from './ids';
import type { Protocol } from './providers';
import type { PermissionMode } from './threads';
import type { Todo, TodoGoal } from './todos';

/** Reserved protocol. Advertise version 1 only after the core implements its boundaries. */
export const SHARED_PROJECT_VERSION = 1 as const;
export interface ContactCapabilities {
  sharedProjects?: typeof SHARED_PROJECT_VERSION;
  /** The peer preserves server-attested contact-human letters instead of treating them as owner input. */
  humanLetters?: 1;
}

/**
 * One explicitly disclosed endpoint, never a group roster or a connection credential.
 * ownerCoreId is the contact-link identity vouching for this side; coreId owns the
 * project and executes its work. They differ for a project on a group member.
 */
export interface SharedProjectRef { ownerCoreId: string; coreId: string; projectId: ProjectId }
/** Canonical host-local thread ID plus its separate advertised address, including a relay alias. */
export interface SharedThreadRef { project: SharedProjectRef; threadId: ThreadId; address: AgentAddress }
/** Minted by the source core from its authenticated caller, never accepted from RPC input. */
export type SharedProjectActor =
  | { kind: 'human'; project: SharedProjectRef }
  | { kind: 'agent'; project: SharedProjectRef; threadId: ThreadId; address: AgentAddress; agent: string };

export interface SharedComputePolicy {
  enabled: boolean;
  /** Host-owned delegation profile IDs. No remote account, command, environment or permission choice. */
  profiles: string[];
  permissionMode: PermissionMode;
  /** null inherits host resource/admission settings; there is no new default concurrency ceiling. */
  maxConcurrent: number | null;
}
/** Each endpoint controls only its own grant; every change increments its durable revision. */
export interface SharedProjectAccess {
  project: SharedProjectRef;
  revision: number;
  board: boolean;
  compute: SharedComputePolicy;
  revokedAt: Timestamp | null;
}
export interface SharedProject {
  /** Immutable association ID; a revoked association can never be reactivated under this ID. */
  id: string;
  projects: [SharedProjectRef, SharedProjectRef];
  /** The proposing project's original execution core, immutable and never replaced on timeout. */
  authority: SharedProjectRef;
  state: 'pending' | 'active' | 'declined' | 'revoked';
  access: [SharedProjectAccess, SharedProjectAccess];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
export interface SharedProjectView {
  shared: SharedProject;
  local: SharedProjectRef;
  remote: SharedProjectRef;
  /** This owner's contact name, resolved locally on each read. No keys, addresses or other contacts. */
  contact: { coreId: string; name: string };
  connection: 'connected' | 'offline' | 'authority-unavailable';
  /** Local endpoint policy summary, with no file paths or inference account/configuration. */
  protection: { defaultDeny: true; activeOverrides: number; reviewer: 'off' | 'idle' | 'reviewing' | 'unavailable' };
}
export interface SharedProjectThread {
  ref: SharedThreadRef;
  agent: AgentContact;
  /** Only the selected endpoint's display name; no member addresses, keys or roster. */
  machine: string;
  readThreads: boolean;
}

export interface SharedBoardAssignment {
  /** Authority-minted identity scoped to association, actor, card and request; also the goal start key. */
  claimId: string;
  actor: SharedProjectActor;
  worker: SharedThreadRef;
  state: 'reserved' | 'running' | 'uncertain' | 'complete';
  /** Attested by the worker host, retained when its thread is unavailable. Contact names stay local. */
  workerInfo?: { agent: string; machine: string };
}
/** Projection into the existing Todo/goal board, not a second four-state task system. */
export interface SharedBoardCard {
  id: string;
  text: string;
  status: Todo['status'];
  revision: number;
  createdBy: SharedProjectActor;
  assignment: SharedBoardAssignment | null;
  goal: TodoGoal | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** A host-local edit awaiting the immutable authority. Never sent as an authoritative change. */
  pending?: boolean;
}
export interface SharedBoardTombstone { id: string; revision: number; deletedAt: Timestamp }
export type SharedBoardChange = { revision: number } & (
  | { kind: 'card'; card: SharedBoardCard }
  | { kind: 'deleted'; tombstone: SharedBoardTombstone }
);
export type SharedBoardPage =
  | { kind: 'snapshot'; revision: number; cards: SharedBoardCard[]; tombstones: SharedBoardTombstone[]; authorityAvailable?: boolean }
  | { kind: 'delta'; from: number; to: number; changes: SharedBoardChange[]; more: boolean; authorityAvailable?: boolean };
/** No caller-supplied actor or goal/checklist: the core attests both from its own journal. */
export type SharedBoardCommand = { requestId: string; cardId: string } & (
  | { kind: 'add'; text: string }
  | { kind: 'update'; text?: string; status?: Todo['status'] }
  | { kind: 'remove' }
  | { kind: 'claim'; expectedRevision: number; worker: SharedThreadRef }
  | { kind: 'release'; claimId: string }
);
export interface SharedBoardReceipt {
  requestId: string;
  /** queued is durable locally and optimistic; it never authorizes starting work. */
  outcome: 'applied' | 'conflict' | 'deleted' | 'revoked' | 'queued';
  revision: number;
  card: SharedBoardCard | null;
}

/** Whether this host can enforce file denial on this route, independently of model instructions. */
export type SharedExecutionProtection =
  | { supported: true; boundary: 'isolated-process' | 'no-tools' }
  | { supported: false; reason: string };
export interface SharedComputeRoute {
  profileId: string;
  providerId: ProviderId;
  protocol: Protocol;
  model: string | null;
  efforts: string[];
  permissionMode: PermissionMode;
  protection: SharedExecutionProtection;
}
/** A host or a workflow can express 4 local + 5 remote without a protocol-imposed split. */
export interface SharedComputeAllocation { project: SharedProjectRef; children: number }
export interface SharedComputeStart {
  requestId: string;
  host: SharedProjectRef;
  profileId: string;
  task: string;
  title?: string;
  /** A commit of the associated repository, validated on the host, never a caller-supplied path. */
  baseCommit: string;
  /** A board claim, when this job implements a card. Admission checks the authority's reservation. */
  claimId?: string;
}
export interface SharedComputeResult {
  /** Credential-free normalized repository identity, checked against both registered projects. */
  repository: string;
  branch: string;
  baseCommit: string;
  commit: string;
  dirty: boolean;
  /** Bounded assistant text only. A result is data, never an executable command or an approval. */
  text: string;
}
export interface SharedComputeJob {
  id: string;
  /** Host-monotonic state version, so a delayed start/get cannot overwrite a newer completion. */
  revision: number;
  sharedProjectId: string;
  requestId: string;
  source: SharedThreadRef;
  host: SharedProjectRef;
  worker: SharedThreadRef | null;
  grantRevision: number;
  profileId: string;
  providerId: ProviderId;
  model: string | null;
  effort: string | null;
  permissionMode: PermissionMode;
  status: 'queued' | 'running' | 'waiting' | 'uncertain' | 'done' | 'failed' | 'cancelled' | 'revoked';
  claimId: string | null;
  result: SharedComputeResult | null;
  /** Bounded sanitized reason, never native process output or credentials. */
  error: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type SharedAccessAction = 'directory' | 'read' | 'letter' | 'board' | 'compute' | 'file' | 'tool' | 'attachment' | 'result';
export type SharedSecretClass = 'environment' | 'private-key' | 'credential' | 'secret' | 'outside-project';
/** Host-local exact canonical relative file, bound to its inode, checkout and grant revision.
 * A jobId binds the captured job checkout; null binds the registered project root only.
 * execute is reserved and rejected until a host can enforce a selective execution boundary.
 */
export interface SharedFileOverride {
  id: string;
  sharedProjectId: string;
  path: string;
  actions: ('read' | 'publish' | 'execute')[];
  jobId: string | null;
  reason: string;
  expiresAt: Timestamp;
  revokedAt: Timestamp | null;
}
/** Sanitized audit metadata only: no prompt, file content, raw tool args or credential paths. */
export interface SharedAccessEvent {
  id: string;
  sharedProjectId: string;
  actor: SharedProjectActor;
  action: SharedAccessAction;
  decision: 'allowed' | 'denied';
  reason: string;
  classification: SharedSecretClass | null;
  jobId: string | null;
  at: Timestamp;
}
/** Host-only configuration; accountId and model settings never enter a peer exchange. */
export type SharedReviewConfig = { enabled: false } | {
  enabled: true;
  providerId: ProviderId;
  accountId: AccountId;
  model: string | null;
  effort: string | null;
  revokeOnViolation: boolean;
};
export interface SharedReviewVerdict {
  id: string;
  sharedProjectId: string;
  eventIds: string[];
  verdict: 'legitimate' | 'suspicious' | 'violation' | 'unavailable';
  reason: string;
  /** Only a locally confirmed violation can apply this consequence. */
  action: 'none' | 'revoked';
  at: Timestamp;
}
export interface SharedAccessPage { events: SharedAccessEvent[]; verdicts: SharedReviewVerdict[]; next: string | null }

/** Every agent-capable local call names its authenticated local source thread. */
export interface SharedProjectScope { threadId: ThreadId; sharedProjectId: string }
export type SharedProjectChangeKind = 'threads' | 'board' | 'compute' | 'access';
/** Missing kinds from an older core means all surfaces. Access audit updates do not invalidate threads. */
export interface SharedProjectChange extends SharedProjectScope { kinds?: SharedProjectChangeKind[] }
export interface SharedProjectsRpcMethods {
  'sharedProjects.list': { params: { threadId: ThreadId }; result: SharedProjectView[] };
  'sharedProjects.get': { params: SharedProjectScope; result: SharedProjectView };
  /** Owner only; never grants readThreads or compute as a side effect. */
  'sharedProjects.offer': { params: { coreId: string; projectId: ProjectId; machine?: string; remote: SharedProjectRef; requestId: string }; result: SharedProjectView };
  'sharedProjects.decide': { params: { sharedProjectId: string; accept: boolean; requestId: string }; result: SharedProjectView };
  'sharedProjects.revoke': { params: { sharedProjectId: string; requestId: string }; result: SharedProjectView };
  /** Host owner only, applied on the endpoint's owning Store/core. */
  'sharedProjects.configure': { params: { sharedProjectId: string; board?: boolean; compute?: SharedComputePolicy; /** Host-local parent whose delegation profiles/accounts back this opt-in. Never forwarded. */ computeThreadId?: ThreadId; reviewer?: SharedReviewConfig }; result: SharedProjectView };
  'sharedProjects.threads': { params: SharedProjectScope; result: { threads: SharedProjectThread[]; unavailable: SharedProjectRef[] } };
  'sharedProjects.search': { params: SharedProjectScope & { query: string }; result: { matches: AgentMatch[]; unavailable: SharedProjectRef[] } };
  'sharedProjects.read': { params: SharedProjectScope & { target: SharedThreadRef; limit?: number; before?: Timestamp }; result: AgentTranscript };
  /** Connection-owned scope, released on unsubscribe, disconnect, project move or revoke. */
  'sharedProjects.subscribe': { params: SharedProjectScope & { enabled: boolean }; result: { ok: true } };
  'sharedBoard.get': { params: SharedProjectScope & { after?: number }; result: SharedBoardPage };
  'sharedBoard.apply': { params: SharedProjectScope & { command: SharedBoardCommand }; result: SharedBoardReceipt };
  /** Start this host's reserved worker once, after checking the authority again. Never queues a start offline. */
  'sharedBoard.start': { params: SharedProjectScope & { cardId: string; claimId: string }; result: SharedBoardReceipt };
  /** Host owner only. Restore the private delegation parent without disclosing it to contacts, devices or agents. */
  'sharedCompute.host': { params: { sharedProjectId: string }; result: { threadId: ThreadId | null } };
  'sharedCompute.models': { params: SharedProjectScope & { host: SharedProjectRef }; result: SharedComputeRoute[] };
  'sharedCompute.start': { params: SharedProjectScope & SharedComputeStart; result: SharedComputeJob };
  'sharedCompute.list': { params: SharedProjectScope; result: SharedComputeJob[] };
  'sharedCompute.get': { params: SharedProjectScope & { jobId: string }; result: SharedComputeJob };
  'sharedCompute.send': { params: SharedProjectScope & { jobId: string; text: string; requestId: string }; result: { ok: true } };
  'sharedCompute.cancel': { params: SharedProjectScope & { jobId: string; requestId: string }; result: SharedComputeJob };
  'sharedAccess.get': { params: SharedProjectScope & { after?: string }; result: SharedAccessPage };
  /** Host owner only: inference accounts/configuration must never reach paired devices, agents or peers. */
  'sharedAccess.reviewConfig': { params: { sharedProjectId: string }; result: SharedReviewConfig };
  /** Host owner only, including exact local override paths; never a peer or reviewer view. */
  'sharedAccess.overrides': { params: { sharedProjectId: string }; result: SharedFileOverride[] };
  /** Host owner only; exact paths are never forwarded to the contact or reviewer. */
  'sharedAccess.override': { params: { sharedProjectId: string; override: Omit<SharedFileOverride, 'id' | 'sharedProjectId' | 'revokedAt'>; requestId: string }; result: SharedFileOverride };
  'sharedAccess.revokeOverride': { params: { sharedProjectId: string; overrideId: string }; result: { ok: true } };
  /** Authenticated owner/paired human, never an agent; the source core attests contact-human. */
  'contacts.sendHuman': { params: { threadId: ThreadId; to: AgentAddress; text: string; requestId: string; replyTo?: string }; result: AgentLetter };
}
export interface SharedProjectsRpcEvents {
  /** Invalidation only; every read rechecks live permissions. Sent only to this connection's shared-project scope. */
  'sharedProjects.changed': SharedProjectChange;
}

/**
 * The single signed/sealed contact.project operation carries these methods,
 * never owner RPC forwarding. The caller core attests source, the receiver
 * resolves its own association and current grantRevision before dispatch.
 * Replies retain the existing coordination envelope nonce/signature/seal.
 */
export interface SharedProjectPeerMethods {
  view: { params: Record<string, never>; result: SharedProject };
  access: { params: { access: SharedProjectAccess }; result: { ok: true } };
  /** Link-bound/expiring scope. No subscription survives revocation or a changed group admission. */
  subscribe: { params: { subscriptionId: string; enabled: boolean; leaseMs: number }; result: { expiresAt: Timestamp } };
  /** Invalidation only, to an admitted subscriber or the source of a nonterminal job; reads enforce scope again. */
  changed: { params: { subscriptionId: string | null; kinds: ('threads' | 'board' | 'compute' | 'access')[]; boardRevision?: number; jobIds?: string[] }; result: { ok: true } };
  threads: { params: Record<string, never>; result: SharedProjectThread[] };
  search: { params: { query: string }; result: AgentMatch[] };
  read: { params: { target: SharedThreadRef; limit?: number; before?: Timestamp }; result: AgentTranscript };
  'board.get': { params: { after?: number }; result: SharedBoardPage };
  'board.apply': { params: { command: SharedBoardCommand; workerInfo?: { agent: string; machine: string } }; result: SharedBoardReceipt };
  /** Durable authority revision hint. Receiver pulls deltas; receiving one never echoes it. */
  'board.changed': { params: { revision: number }; result: { ok: true } };
  /** Only the authority may ask the assigned host to stop this exact claim before releasing it. */
  'board.stop': { params: { cardId: string; claimId: string; worker: SharedThreadRef }; result: { stopped: true } };
  /** Only the attested worker host, from its journalled goal and current claim. */
  'board.progress': { params: { cardId: string; claimId: string; worker: SharedThreadRef; goal: TodoGoal | null; sequence: number; reviewPassedAt: Timestamp | null }; result: SharedBoardReceipt };
  'compute.models': { params: { host: SharedProjectRef }; result: SharedComputeRoute[] };
  'compute.start': { params: SharedComputeStart & { source: SharedThreadRef; repository: string }; result: SharedComputeJob };
  'compute.get': { params: { jobId: string }; result: SharedComputeJob };
  'compute.send': { params: { jobId: string; text: string }; result: { ok: true } };
  'compute.cancel': { params: { jobId: string; /** Permanently closes a released board claim, including a completed job's follow-ups. */ closeClaim?: true; /** Allows a cancellation fence to arrive before a delayed start. */ input?: SharedComputeStart; repository?: string; source?: SharedThreadRef }; result: SharedComputeJob };
  /** May only close the sender's access. It cannot widen or restore the receiver's grant. */
  revoke: { params: Record<string, never>; result: { ok: true } };
}
export type SharedProjectPeerRequest = { route?: {source: SharedProjectRef; target: SharedProjectRef} } & (
  | { method: 'offer'; requestId: string; project: SharedProject }
  | { method: 'decide'; requestId: string; sharedProjectId: string; accept: boolean }
  | { [M in keyof SharedProjectPeerMethods]: {
      method: M;
      requestId: string;
      sharedProjectId: string;
      grantRevision: number;
      source: SharedProjectActor;
      params: SharedProjectPeerMethods[M]['params'];
    } }[keyof SharedProjectPeerMethods]);
