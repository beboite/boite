/*
 * Who may call what.
 *
 * The owner is the process holding the core token: the shell, the dev client,
 * anything that can read `core.json`. A paired device holds a session token it
 * got through a pairing link, and it is a guest: it reads the threads, answers
 * what an agent asks and sends prompts, and that is all.
 *
 * An agent holds the per-thread token the core put in the environment of a
 * process its thread launched. It is the narrowest of the three: it reaches
 * `AGENT_METHODS` and only ever on its own thread.
 *
 * The device lists live in `packages/contracts/src/access.ts`, where the
 * in-memory client reads them too; the agent list is below. Together they are
 * the whole boundary: read them when asking what a stolen phone, or an agent
 * that went off, is worth. A method that is in neither is the owner's: a new
 * method added tomorrow is refused to both until someone decides otherwise,
 * on purpose.
 */

import { AGENT_EVENTS, DEVICE_EVENTS, DEVICE_METHODS, type RpcEventName, type RpcMethodName } from '@boite/contracts';
import { refused } from './errors.ts';
import type { Connection } from './router.ts';

export { AGENT_EVENTS, DEVICE_EVENTS, DEVICE_METHODS };

export function isDeviceMethod(method: RpcMethodName): boolean {
  return DEVICE_METHODS.has(method);
}

export function mayReceiveEvent(name: RpcEventName, connection: Connection): boolean {
  if (connection.identity.principal === 'owner') return true;
  return (connection.identity.principal === 'agent' ? AGENT_EVENTS : DEVICE_EVENTS).has(name);
}

/**
 * What the agent of a thread reaches, and why each one is worth the risk of a
 * token that sits in the environment of a process the user did not write. Read
 * this as the CLI's manual: the agent says where it is, shows the user
 * something, keeps its task list and the project's cards, reads the changes and
 * the files around it. Delegation can start a child only on owner-approved
 * routes within that thread's team budget. Every call is held to the token's
 * thread; team methods check the relationship before reaching a child. None
 * of these methods changes the owner's trust, routes or permissions.
 */
export const AGENT_METHODS: ReadonlyMap<RpcMethodName, string> = new Map<RpcMethodName, string>([
  ['agents.routine.save', 'bounded durable scheduling for its own identity from its direct conversation, when the owner enabled routines'],
  ['agents.snapshot', 'only the persistent identity, context and resources of this execution'],
  ['agents.history', 'older messages, work and memory of this execution context, under the snapshot rules'],
  ['agents.message.send', 'a bounded message as this agent to recipients in its current conversation'],
  ['agents.memory.save', 'scoped memory with mandatory provenance, no widening of access'],
  ['agents.task.acquire', 'atomic self-assignment inside the current authorized mission'],
  ['agents.task.submit', 'submission by the current assignment generation, never final approval'],
  ['agents.artifact.add', 'versioned results from the current mission and working directory'],
  ['agents.decision.request', 'durable requests for a human decision without an idle provider process'],
  ['delegation.get', 'its own team summaries, approved profiles and remaining budget'],
  ['delegation.spawn', 'one direct child on an owner-approved route, within durable team limits'],
  ['delegation.send', 'messages only between this parent and its direct children'],
  ['delegation.stop', 'stop its own children or itself, never unrelated work'],
  ['workflows.list', 'the runs of its own thread, or of its parent for a step'],
  ['workflows.get', 'one run of its own thread, or of its parent for a step'],
  ['workflows.check', 'validating a plan against its own approved profiles, without starting anything'],
  ['workflows.start', 'a graph of child threads on owner-approved profiles, held to the same team budget and concurrency as delegation'],
  ['workflows.extend', 'more steps on a run it started, under the same checks'],
  ['workflows.control', 'pause, stop or retry runs it started; resuming a paused team stays with the owner'],
  ['workflows.output', 'the structured result of the step this thread is, checked against its declared shape'],
  ['workflows.templates.list', 'the plans kept for its own project'],
  ['workflows.templates.save', 'keeping a plan for its own project; a template runs only through workflows.start'],
  ['collaboration.get', 'its own coordination inbox and remaining budget, never other conversations'],
  ['collaboration.directory', 'opted-in contacts in this project and explicitly trusted machines'],
  ['collaboration.send', 'authenticated delivery as this thread to a separately authorized recipient'],
  ['agent.where', 'the thread, its project, its working directory and its branch: what the CLI prints first'],
  ['panel.open', 'showing the user a file, a diff or a page instead of pasting it into the transcript'],
  ['questions.ask', 'a question card on its own thread that it does not wait on; the answer comes back as a message'],
  ['artifacts.publish', 'explicitly sharing a bounded snapshot from its own working directory in its own conversation'],
  ['threads.tasks.set', 'the plan the tasks surface draws, from an agent whose protocol carries no todo tool'],
  ['threads.tasks.get', 'the same plan read back, so a new process continues the list it did not write'],
  ['todos.list', 'the project cards, shared with the other threads of the project'],
  ['todos.add', 'what surfaced during the work and belongs to the project, not to this turn'],
  ['todos.update', 'claiming a card it finished, which is a request for confirmation, never the confirmation'],
  ['git.status', 'what it changed in the working directory, without spawning a git of its own'],
  ['git.diff', 'both sides of one file, for the same reason'],
  ['files.list', 'one directory of the working directory it already runs in'],
  ['files.read', 'one file of it, text inline and anything else through a ticket'],
]);

export function isAgentMethod(method: RpcMethodName): boolean {
  return AGENT_METHODS.has(method);
}

/**
 * Throws unless the connection may call the method, naming the method. The
 * params are read for one thing only: an agent speaks for its own thread, so a
 * call naming another one is refused before the handler sees it.
 */
export function assertAllowed(method: RpcMethodName, connection: Connection, params?: unknown): void {
  const identity = connection.identity;
  if (identity.principal === 'owner') return;
  if (identity.principal === 'agent') {
    if (!isAgentMethod(method)) throw refused(`${method} is not one of the agent's methods`, { method, principal: 'agent' });
    const named = (params as { threadId?: unknown } | null | undefined)?.threadId;
    if (identity.threadId === null || named !== identity.threadId) {
      throw refused(`${method} is for thread ${identity.threadId ?? 'none'}, not thread ${String(named)}`, {
        method,
        threadId: named,
      });
    }
    return;
  }
  if (method === 'agents.message.send' && (params as { threadId?: unknown } | null | undefined)?.threadId !== undefined) throw refused('agents.message.send: paired devices must omit threadId and speak as the user');
  if (isDeviceMethod(method)) return;
  throw refused(`${method} is for the owner only`, { method, principal: identity.principal });
}
