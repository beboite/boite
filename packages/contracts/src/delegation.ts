import type { ContextPreset, ContextRequest } from './context-mode';
import type { AgentLetter } from './coordination';
import type { AccountId, ProviderId, RequestId, ThreadId, Timestamp, TurnId } from './ids';
import type { SpeedTier } from './providers';
import type { ThreadSummary } from './threads';
import type { Turn } from './turns';
import type { Usage } from './usage';

/** Owner-selected routes. Agents name a profile, never arbitrary credentials or permissions. */
export interface DelegationProfile {
  id: string;
  name: string;
  providerId: ProviderId;
  accountId: AccountId;
  model: string;
  effort: string | null;
}
/**
 * Who paused a team or a workflow run, which decides who may lift the pause.
 * `owner`: Subagents > Settings, or a run paused from its panel or a phone.
 * `stop`: the owner's Stop on the conversation. `agent`: the conversation's
 * own agent. `restart`: the core restarted over the work. The agent lifts its
 * own and a restart's at any time, a Stop or a paused run once the owner wrote
 * to the conversation after it, and never the Settings switch.
 */
export type PauseOrigin = 'owner' | 'stop' | 'agent' | 'restart';
export interface DelegationConfig {
  enabled: boolean;
  paused: boolean;
  /** Set by the core while paused; a pause saved before it was recorded reads as the owner's. Ignored in `delegation.configure`. */
  pausedBy?: PauseOrigin;
  pausedAt?: Timestamp;
  profiles: DelegationProfile[];
  /**
   * The agent may start a child on any installed model it can run, with any
   * reasoning level that model offers. Off, it is held to this conversation's
   * model and the profiles. Missing on older cores and saved configs: on.
   */
  anyModel?: boolean;
}
/** What `delegation.resume` did: whether the pause lifted, which children got a continuation, which runs resumed. */
export interface DelegationResumed {
  unpaused: boolean;
  agents: ThreadId[];
  runs: string[];
}
/**
 * On from the first turn: a conversation delegates to its own model, or to
 * any other installed model, with nothing to set up. Owner profiles name
 * suggested routes.
 */
export const DEFAULT_DELEGATION_CONFIG: DelegationConfig = {
  enabled: true, paused: false, profiles: [], anyModel: true,
};
/** One model a delegating agent may name, on the account Boite would use for it. */
export interface DelegationModelChoice {
  providerId: ProviderId;
  providerName: string;
  accountId: AccountId;
  model: string;
  name: string;
  /** Reasoning levels this model offers, lowest first. Empty: no reasoning control. */
  efforts: string[];
  defaultEffort: string | null;
  /** Native service tiers this model offers, such as `fast`. Empty: no speed control. Missing on older cores. */
  speeds?: SpeedTier[];
  /** The parent conversation's own model. */
  current: boolean;
}
/**
 * A speed named by id, by label or the way it is listed (`Fast (priority)`), any
 * case: `fast` is Claude's `fast` and the Codex tier `priority` labelled "Fast".
 * Padding is ignored on both sides; the id comes back exactly as the model
 * advertises it, which is what a thread's speed is checked against. Null for
 * anything else.
 */
export function matchSpeed(speeds: readonly SpeedTier[] | null | undefined, wanted: unknown): string | null {
  if (typeof wanted !== 'string') return null;
  const query = wanted.trim().toLowerCase();
  if (!query || !speeds) return null;
  const by = (name: (speed: SpeedTier) => string) => speeds.find(speed => name(speed).trim().toLowerCase() === query);
  return (by(speed => speed.id) ?? by(speed => speed.label) ?? by(speedName))?.id ?? null;
}
/** How a tier is written for an agent: its id, with the label in front when the label says something else, as `Fast (priority)`. */
export function speedName(speed: SpeedTier): string {
  const label = speed.label.trim(), id = speed.id.trim();
  return !id ? label : (!label || label.toLowerCase() === id.toLowerCase() ? id : `${label} (${id})`);
}
/** Why a speed is refused on a route that runs on the provider's default model: no model, no tiers to choose from. */
export const SPEED_NEEDS_MODEL = 'speed: this route runs on the provider\'s default model; name a model with --model to choose its speed';
/**
 * Why a speed is refused: the model and the tiers it offers, or that it offers
 * none; with no list at all, that its tiers are not read yet and what reads
 * them. The same words for the CLI and the MCP tool.
 */
export function speedRefusal(model: string, speeds: readonly SpeedTier[] | null | undefined, wanted: string): string {
  if (!speeds) return `speed: the tiers of ${model} are not read yet; list the delegation models and spawn again`;
  if (!speeds.length) return `speed: ${model} offers no speed tier; leave speed out`;
  return `speed: ${model} has no "${wanted.trim()}" tier; expected ${speeds.map(speedName).join(', ')}`;
}
export interface DelegationModels {
  anyModel: boolean;
  choices: DelegationModelChoice[];
  /** Installed providers whose models could not be read, with the reason. */
  unavailable: { providerId: ProviderId; reason: string }[];
}
/** The profile every conversation has without configuring one: its own harness, account, model and effort. */
export const CONVERSATION_PROFILE_ID = 'conversation';
export interface DelegationResultRef { agentId: ThreadId; turnId: TurnId }
/** `needs_input`: a child waits on a question or a permission request; its `needsInput` says which. */
export type DelegationSettlement = 'result_available' | 'waiting_for_children' | 'needs_input' | 'settled';
export interface DelegationWaitResult {
  /**
   * Single-child completion exposes its result; a whole finished team is
   * settled. A wait also ends, as `needs_input`, as soon as a child it covers
   * asks something.
   */
  state: DelegationSettlement;
  timedOut: boolean;
  agents: DelegatedAgent[];
}
export interface DelegationResultPage {
  resultRef: DelegationResultRef;
  text: string;
  /** Offsets count Unicode code points; text contains at most 16000 UTF-16 units. */
  offset: number;
  nextOffset: number | null;
  total: number;
}
export interface DelegatedAgent {
  thread: ThreadSummary;
  profileId: string;
  task: string;
  lastTurn: Turn | null;
  /** Bounded final answer, without tool payloads or a summarization model call. */
  result: string | null;
  resultRef?: DelegationResultRef;
  /** A child's terminal result availability, not ownership of nested children. */
  settlement?: 'result_available' | 'settled';
  /** What the child waits on from someone, oldest first. Missing when nothing is open. */
  needsInput?: DelegationInput[];
  /** The child's own git worktree, for a child spawned with `worktree`. Missing for a child in the shared checkout. */
  worktree?: DelegationWorktree;
}
/**
 * A card a delegated child waits on. A question's free text or one of its
 * option labels, sent by the parent with `delegation.send`, answers it; a
 * permission request only the user can decide, in the child's conversation.
 */
export type DelegationInput =
  | { kind: 'question'; id: RequestId; text: string; options: string[]; allowText: boolean; multiple: boolean; blocking: boolean }
  | { kind: 'permission'; id: RequestId; toolName: string; description: string | null };
/**
 * A delegated child's worktree. `pending`: not made yet, it is made from the
 * parent's HEAD before the child's next turn. `active`: the child works in it.
 * `kept`: its last turn left commits beyond `base` or uncommitted changes, so
 * the branch waits for the parent to merge it. `removed`: it ended with
 * neither, so the worktree and its branch were deleted; a new turn makes them
 * again from the parent's HEAD.
 */
export interface DelegationWorktree {
  branch: string;
  path: string;
  /** The reserved base commit; null until preparation reaches its first mutation. */
  base: string | null;
  state: 'pending' | 'active' | 'kept' | 'removed';
  /** Commits on the branch beyond `base` when it was last settled. */
  commits?: number;
  /** Uncommitted changes when it was last settled. */
  dirty?: boolean;
  /** Why the core could not settle or make it, when it could not. */
  error?: string;
}
export interface DelegationView {
  rootThreadId: ThreadId;
  /** This parent's direct children only. Native tasks have separate lifecycle. */
  settlement?: 'waiting_for_children' | 'settled';
  config: DelegationConfig;
  agents: DelegatedAgent[];
  /** Provider children and traced CLI agents, including earlier message pages and process history. */
  nativeAgents: NativeAgent[];
  messages: AgentLetter[];
  turnsUsed: number;
  usage: Usage;
}

export interface NativeAgentUpdate {
  id: string;
  name?: string;
  task?: string;
  model?: string;
  status: 'running' | 'done' | 'error' | 'stopped' | 'unknown';
  result?: string;
}
export interface NativeAgent extends NativeAgentUpdate {
  toolId: string;
  startedAt: Timestamp;
  /** Absent on provider reports. Process-backed agents follow their own exit, not the launch tool. */
  source?: 'process';
  effort?: string;
  finishedAt?: Timestamp;
}

export interface DelegationRpcMethods {
  'delegation.get': { params: { threadId: ThreadId }; result: DelegationView };
  'delegation.configure': { params: { threadId: ThreadId; config: DelegationConfig }; result: DelegationView };
  /**
   * `model` is `provider/model` or a model id `delegation.models` lists; it
   * wins over `profileId`. Neither: this conversation's own model. `speed` is
   * a tier of the model the child runs on, by id, by label or as listed
   * (`Fast (priority)`), case-insensitively, and is refused otherwise. Left
   * out: no tier, never the parent's. `context` starts the child without
   * part of the user's setup; left out, it gets all of it.
   *
   * `worktree: true` runs the child in a git worktree of its own on a new
   * `boite/sub-<id>` branch from the parent's current HEAD (the entrusted
   * project's for a bot) instead of the shared checkout; refused outside a
   * git repository. Uncommitted edits are not copied.
   * A bot can name an entrusted `project` by id, name or path. Without it,
   * its sole entrusted project is used; otherwise the child stays personal.
   * Project children of bots appear in that project's conversation list.
   */
  'delegation.spawn': { params: { threadId: ThreadId; project?: string; profileId?: string; model?: string; effort?: string; speed?: string; context?: ContextRequest | ContextPreset; task: string; title?: string; worktree?: boolean; requestId: string }; result: DelegatedAgent };
  /**
   * With `machine` (a member's name or core id prefix), that machine's
   * models, read from it now while its owner keeps `groupThreads` on; `current`
   * marks this conversation's model there.
   */
  'delegation.models': { params: { threadId: ThreadId; machine?: string }; result: DelegationModels };
  /**
   * From a parent to a child blocked on a question card, the text answers
   * that question (an option label, or free text where it takes some) and the
   * letter carries `answered`; a text that fits neither is refused with the
   * options. A question asked without stopping takes only its option labels.
   * Otherwise a message delivered at the next tool boundary or turn
   * (`delegationReply`).
   */
  'delegation.send': { params: { threadId: ThreadId; toThreadId: ThreadId; text: string; requestId: string }; result: AgentLetter };
  'delegation.stop': { params: { threadId: ThreadId; agentId?: ThreadId }; result: { stopped: number } };
  /**
   * Lifts the team's pause when the caller may (`PauseOrigin`), hands over the
   * mail it held and sends each stopped or failed child, or only `agentId`, a
   * continuation. Without `agentId` it also resumes the root's paused runs the
   * caller may resume. Refused with the reason when the pause stays.
   */
  'delegation.resume': { params: { threadId: ThreadId; agentId?: ThreadId }; result: DelegationResumed };
  'delegation.result': { params: { threadId: ThreadId; agentId: ThreadId; turnId: TurnId; offset?: number; limit?: number }; result: DelegationResultPage };
  'delegation.wait': { params: { threadId: ThreadId; agentId?: ThreadId; timeoutMs?: number }; result: DelegationWaitResult };
}

export interface DelegationRpcEvents {
  'delegation.changed': { threadId: ThreadId };
}
