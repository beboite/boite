/** Teams of bots behind their experiment behave alike on the real core and the in-memory transport (`docs/teams.md`). */
import { RpcErrorCode, type AgentProfile } from '../../packages/contracts/src/index.ts';
import type { ContractEnv, Scenario } from './scenarios.ts';

function check(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(reason); }
function same(actual: unknown, expected: unknown, what: string): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
/** The refusal's data, once the call failed with `code`. */
async function refused(call: Promise<unknown>, code: number): Promise<Record<string, unknown>> {
  let failure: unknown;
  try { await call; } catch (error) { failure = error; }
  const e = failure as { code?: number; data?: Record<string, unknown>; rpc?: { code: number; data?: Record<string, unknown> } } | undefined;
  check((e?.rpc?.code ?? e?.code) === code, `expected ${code}, got ${String(failure)}`);
  return e?.rpc?.data ?? e?.data ?? {};
}
const experiments = (env: ContractEnv, on: boolean) =>
  env.call('client.preferences', { app: 'app-desktop-0001', language: 'en', experiments: on ? ['teams'] : [], labels: {} });

export const TEAM_SCENARIOS: Record<string, Scenario> = {
  'teams wait for their experiment; posts route by name, bots read only what they may see, and other machines wait for a later version': async (env: ContractEnv) => {
    await experiments(env, false);
    same((await refused(env.call('teams.list', {}), RpcErrorCode.Refused)).reason, 'experiment-off', 'the refusal with the experiment off');
    await experiments(env, true);
    const bots: AgentProfile[] = [];
    try {
      const { loaded } = await env.call('providers.list', {});
      const provider = loaded.find(entry => entry.protocol === 'echo');
      check(provider, 'no echo provider');
      const account = (await env.call('accounts.list', {})).find(entry => entry.providerId === provider.id);
      check(account, 'no echo account');
      const model = (provider.models.find(entry => entry.default === true) ?? provider.models[0])!.id;
      const tag = Math.random().toString(36).slice(2, 7);
      // Paused bots: nothing runs, the posts wait for them.
      const bot = async (name: string) => {
        const agent = await env.call('agents.profile.save', { value: { name, domain: '', instructions: '', avatar: '', selection: { providerId: provider.id, accountId: account.id, model, effort: null, permissionMode: 'default' }, status: 'paused' } });
        bots.push(agent);
        return { agent, threadId: (await env.call('agents.open', { agentId: agent.id })).threadId };
      };
      const ada = await bot(`Ada${tag}`);
      const bob = await bot(`Bob${tag}`);

      const team = await env.call('teams.create', { name: `Crew ${tag}`, members: [ada.agent.id] });
      same([team.members.length, team.lastSeq, team.createdBy, team.version], [1, 0, 'owner', 1], 'a new team');
      const adaKey = team.members[0]!.key;
      same((await refused(env.call('teams.create', { name: `crew ${tag}`, members: [ada.agent.id] }), RpcErrorCode.Refused)).field, 'name', 'a second team of that name');
      same((await refused(env.call('teams.create', { name: `Far ${tag}`, members: ['pc/Cy'] }), RpcErrorCode.Refused)).field, 'members', 'a member on another machine');
      await refused(env.call('teams.create', { name: `Empty ${tag}`, members: [] }), RpcErrorCode.InvalidParams);
      same((await env.call('teams.update', { teamId: team.id, brief: 'Ship it' })).version, 2, 'a change moves the version');
      const joined = await env.call('teams.members.add', { teamId: team.id, botId: bob.agent.name });
      const bobKey = joined.members.find(member => member.botId === bob.agent.id)?.key;
      same(joined.members.length, 2, 'members after an add');
      same((await refused(env.call('teams.members.add', { teamId: team.id, botId: bob.agent.id }), RpcErrorCode.Refused)).field, 'botId', 'adding a member twice');

      const first = await env.call('teams.post', { teamId: team.id, id: `p1-${tag}`, text: `@Ada${tag} check the build` });
      same([first.seq, first.author, first.to, first.routedBy], [1, 'owner', [adaKey], 'mention'], 'a post naming a bot');
      same((await env.call('teams.post', { teamId: team.id, id: `p1-${tag}`, text: `@Ada${tag} check the build` })).seq, 1, 'a retried post');
      same((await refused(env.call('teams.post', { teamId: team.id, id: `p1-${tag}`, text: 'other' }), RpcErrorCode.Refused)).field, 'id', 'a reused id with other text');
      const nobody = await env.call('teams.post', { teamId: team.id, id: `p2-${tag}`, text: 'status' });
      check(nobody.routedBy === 'none' && nobody.to.length === 0 && typeof nobody.notice === 'string', `an owner post naming nobody: ${JSON.stringify(nobody)}`);

      // A bot's methods name its thread: the owner may call them for it, an agent token only for its own.
      same((await env.call('teams.list', { threadId: ada.threadId })).teams.map(entry => entry.id), [team.id], 'a bot\'s teams');
      // The team chat runs no agent: what would reach a provider refuses there.
      for (const call of [() => env.call('turns.start', { threadId: team.threadId, prompt: 'hello', clientRequestId: `team-turn-${tag}` }), () => env.call('threads.retitle', { threadId: team.threadId })]) {
        check(String((await refused(call(), RpcErrorCode.Refused)).threadId) === team.threadId, 'a team chat ran an agent call');
      }
      check(!(await env.call('threads.get', { threadId: team.threadId })).unread, 'the owner\'s own posts marked the team chat unread');
      const everyone = await env.call('teams.say', { threadId: ada.threadId, team: team.name, text: '@tous done', id: `s1-${tag}` });
      same([everyone.author, everyone.to, everyone.routedBy], [adaKey, [bobKey], 'everyone'], 'a bot\'s post to everyone leaves out its author');
      check((await env.call('threads.get', { threadId: team.threadId })).unread, 'a bot\'s post left the team chat read');
      const answer = await env.call('teams.say', { threadId: ada.threadId, team: team.id, text: 'on it', inReplyTo: first.id });
      same([answer.to, answer.routedBy], [['owner'], 'reply'], 'a reply');
      const secret = await env.call('teams.dm', { threadId: ada.threadId, team: team.name, to: 'owner', text: 'between us', id: `d1-${tag}` });
      same([secret.audience, secret.to], ['private', ['owner']], 'a private post');
      same((await refused(env.call('teams.dm', { threadId: ada.threadId, team: team.name, to: 'pc/Cy', text: 'hi' }), RpcErrorCode.Refused)).field, 'to', 'a private post to another machine');
      const agent = await env.peer({ agentThreadId: ada.threadId });
      await refused(agent.call('teams.create', { name: `Mine ${tag}`, members: [ada.agent.id] }), RpcErrorCode.Refused);
      await refused(agent.call('teams.say', { threadId: bob.threadId, team: team.id, text: 'as Bob' }), RpcErrorCode.Refused);
      agent.disconnect();

      const bobReads = await env.call('teams.read', { threadId: bob.threadId, team: team.id });
      check(!bobReads.posts.some(post => post.id === secret.id) && bobReads.deliveries.length === 0, 'a bot read another\'s private post or the deliveries');
      const ownerReads = await env.call('teams.read', { team: team.id, limit: 2 });
      same([ownerReads.posts.map(post => post.seq), ownerReads.more], [[4, 5], true], 'the owner\'s newest page');
      check((await env.call('teams.read', { team: team.id })).deliveries.some(entry => entry.postId === first.id && entry.member === adaKey), 'the owner reads no delivery of the first post');

      same((await refused(env.call('teams.invite', { threadId: ada.threadId, team: team.id, bot: 'pc/Cy' }), RpcErrorCode.Refused)).field, 'bot', 'inviting a bot of another machine');
      await refused(env.call('teams.propose', { threadId: ada.threadId, name: `Solo ${tag}`, members: [ada.agent.id] }), RpcErrorCode.InvalidParams);
      same((await refused(env.call('teams.leave', { threadId: ada.threadId, team: `none ${tag}` }), RpcErrorCode.Refused)).field, 'team', 'leaving a team it is not in');

      same((await env.call('teams.pause', { teamId: team.id, paused: true })).paused, true, 'a paused team');
      same((await env.call('teams.pause', { teamId: team.id, paused: false })).paused, false, 'a resumed team');
      same((await env.call('teams.members.remove', { teamId: team.id, botId: bob.agent.id })).members.map(member => member.key), [adaKey], 'members after a removal');
      same((await refused(env.call('teams.read', { threadId: bob.threadId, team: team.id }), RpcErrorCode.Refused)).field, 'team', 'a removed bot reading');
      same((await env.call('teams.archive', { teamId: team.id, archived: true })).archived, true, 'an archived team');
      same((await refused(env.call('teams.post', { teamId: team.id, id: `p9-${tag}`, text: 'late' }), RpcErrorCode.Refused)).field, 'team', 'a post to an archived team');
      check(!(await env.call('teams.list', {})).teams.some(entry => entry.id === team.id), 'an archived team is listed');
      check((await env.call('teams.list', { archived: true })).teams.some(entry => entry.id === team.id), 'an archived team is gone from the archived list');
    } finally {
      for (const agent of bots) await env.call('agents.profile.save', { id: agent.id, expectedRevision: agent.revision, value: { ...agent, status: 'archived' } }).catch(() => undefined);
      await experiments(env, false);
    }
  },
};
