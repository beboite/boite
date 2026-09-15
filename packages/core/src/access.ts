/*
 * Who may call what.
 *
 * The owner is the process holding the core token: the shell, the dev client,
 * anything that can read `core.json`. A paired device holds a session token it
 * got through a pairing link, and it is a guest: it reads the threads, answers
 * what an agent asks and sends prompts, and that is all.
 *
 * The list below is the whole boundary, so it is the one place to read when
 * asking what a stolen phone is worth. A method that is not in it is the
 * owner's: a new method added tomorrow is refused to a device until someone
 * decides otherwise, on purpose.
 */

import type { RpcMethodName } from '@boite/contracts';
import { refused } from './errors.ts';
import type { Connection } from './router.ts';

/**
 * What a paired device reaches. Read this as the phone's screen: the sidebar,
 * a thread, the composer, the cards an agent raises, and the settings it only
 * displays. Nothing here writes outside a thread, names a path, starts a
 * process of its own or changes what the core trusts.
 */
export const DEVICE_METHODS: ReadonlySet<RpcMethodName> = new Set<RpcMethodName>([
  // Its own pairing, so a phone can show itself in the device list.
  'sessions.list',
  // The sidebar and the composer's `@`.
  'projects.list',
  'projects.files',
  // What a thread needs to name its agent.
  'providers.list',
  'accounts.list',
  // The threads themselves.
  'threads.list',
  'threads.pullRequest', // Read-only branch metadata shown on the same phone thread cards.
  'threads.create',
  'threads.get',
  // A phone can manage continued prompts in the same thread it can already send to.
  'threads.activity.set',
  'threads.activity.control',
  'messages.list',
  'threads.update',
  'threads.retitle',
  'threads.compact', // A paired device can request the same session maintenance as the desktop.
  'threads.archive',
  'threads.pin',
  'threads.markRead',
  'threads.subscribe',
  'threads.unsubscribe',
  'turns.start',
  'turns.stop',
  // The point of carrying the phone: answering the agent from anywhere.
  'permissions.list',
  'permissions.answer',
  'questions.list',
  'questions.answer',
  // Read-only screens.
  'scheduler.get',
  'usage.get',
  'settings.get',
  'keybindings.get',
]);

export function isDeviceMethod(method: RpcMethodName): boolean {
  return DEVICE_METHODS.has(method);
}

/** Throws unless the connection may call the method, naming the method. */
export function assertAllowed(method: RpcMethodName, connection: Connection): void {
  if (connection.identity.principal === 'owner') return;
  if (isDeviceMethod(method)) return;
  throw refused(`${method} is for the owner only`, { method, principal: connection.identity.principal });
}
