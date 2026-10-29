/** Contact mail outside a shared project, held for the owner, behaves alike on the real core and the in-memory transport. */
import { RpcErrorCode } from '../../packages/contracts/src/index.ts';
import type { ContractEnv, Scenario } from './scenarios.ts';

function check(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(reason); }
async function refused(call: Promise<unknown>, code: number) {
  let failure: unknown;
  try { await call; } catch (error) { failure = error; }
  const e = failure as { code?: number; rpc?: { code: number } } | undefined;
  check((e?.rpc?.code ?? e?.code) === code, `expected ${code}, got ${String(failure)}`);
}
async function until(test: () => Promise<boolean>, reason: string) {
  const end = Date.now() + 10_000;
  while (!await test()) { check(Date.now() < end, reason); await new Promise(resolve => setTimeout(resolve, 10)); }
}

export const CONTACT_MAIL_SCENARIOS: Record<string, Scenario> = {
  'a contact\'s answer outside a shared project waits for the owner, who alone delivers or refuses it': async (env: ContractEnv) => {
    const contact = await env.newContact();
    await contact.call('contacts.join', { link: (await env.call('contacts.invite', { share: false })).link });
    for (const side of [env, contact]) await side.call('contacts.settings', { settings: { minTier: 2 } });
    const coreId = (await contact.call('collaboration.identity', {})).coreId;
    const account = (await env.call('accounts.list', {})).find(entry => entry.providerId === 'echo')!;
    const project = await env.call('projects.add', { path: await env.newFolder(), name: 'Mail contract' });
    // Echo in default mode reads contact mail without tools; this thread may edit files, so its mail waits.
    const thread = await env.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Asks a contact', permissionMode: 'acceptEdits' });
    const status = async (id: string) => (await env.call('collaboration.get', { threadId: thread.id })).messages.find(letter => letter.id === id)?.status;
    const held = async () => (await env.call('contacts.get', {})).mail ?? [];
    const answered = async (text: string) => {
      await env.call('collaboration.ask', { threadId: thread.id, contact: coreId, text });
      const incoming = async () => (await contact.call('contacts.get', {})).requests.find(request => request.direction === 'in' && request.status === 'pending' && request.text === text);
      await until(async () => Boolean(await incoming()), 'the contact never received the request');
      await contact.call('contacts.decide', { id: (await incoming())!.id, accept: false, reason: `No: ${text}` });
      const find = async () => (await held()).find(letter => letter.threadId === thread.id && letter.text.includes(`No: ${text}`));
      await until(async () => Boolean(await find()), 'the answer never waited for the owner');
      return (await find())!;
    };

    const first = await answered('First note');
    check(first.coreId === coreId && first.thread === 'Asks a contact', `wrong held letter: ${JSON.stringify(first)}`);
    check(await status(first.id) === 'received', 'a held letter reached the agent');
    check(!(await env.call('threads.get', { threadId: thread.id })).contactHold, 'held mail paused its thread');
    // Only the owner decides, with a boolean.
    await refused((await env.peer({ agentThreadId: thread.id })).call('contacts.decideMail', { id: first.id, accept: true }), RpcErrorCode.Refused);
    await refused(env.call('contacts.decideMail', { id: first.id, accept: 'yes' as never }), RpcErrorCode.InvalidParams);
    await env.call('contacts.decideMail', { id: first.id, accept: false });
    check(await status(first.id) === 'rejected', 'a refused letter was not rejected');
    check(!(await held()).some(letter => letter.id === first.id), 'a refused letter still waits');
    await refused(env.call('contacts.decideMail', { id: first.id, accept: true }), RpcErrorCode.InvalidParams);

    const second = await answered('Second note');
    await env.call('contacts.decideMail', { id: second.id, accept: true });
    await until(async () => await status(second.id) === 'delivered', 'a delivered letter never reached the agent');
    check(!(await held()).some(letter => letter.id === second.id), 'a delivered letter still waits');
  },
};
