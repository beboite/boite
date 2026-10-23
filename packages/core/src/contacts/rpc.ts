/** The contact methods: `contacts.*` for the owner, `collaboration.contacts` and `collaboration.ask` for agents. Who may call which is in `access.ts`. */
import type { Core } from '../core.ts';

export function registerContactMethods(core: Core): void {
  core.router.register('contacts.get', () => core.contacts.state());
  core.router.register('contacts.invite', p => core.contacts.invite(p.share, p.internet));
  core.router.register('contacts.cancelInvites', () => core.contacts.cancelInvites());
  core.router.register('contacts.join', p => core.contacts.join(p.link));
  core.router.register('contacts.update', p => core.contacts.update(p));
  core.router.register('contacts.grant', p => core.contacts.grant(p));
  core.router.register('contacts.revoke', p => core.contacts.revoke(p));
  core.router.register('contacts.remove', p => core.contacts.remove(p.coreId));
  core.router.register('contacts.decide', p => core.contacts.decide(p));
  core.router.register('contacts.settings', p => core.contacts.setSettings(p.settings));
  core.router.register('contacts.tailscaleKey', p => core.contacts.setTailscaleKey(p.key));
  core.router.register('collaboration.contacts', p => core.contacts.forThread(p.threadId));
  core.router.register('collaboration.ask', p => core.contacts.ask(p));
}
