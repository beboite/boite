import type { AgentMessageFile, ArtifactContent, Message, Turn } from '@boite/contracts';
import { requestAgentSetting } from './agent-settings';
import type { FakeContext } from './context';
import { FAKE_MEDIA } from './files';
import { requestSignIn } from './requests';

/** Pictures the demo's agent attached, served by `artifacts.read` beside the ones a turn publishes. */
const seeded = new WeakMap<FakeContext, Map<string, ArtifactContent>>();

export function seededArtifact(ctx: FakeContext, artifactId: string): ArtifactContent | undefined {
  const value = seeded.get(ctx)?.get(artifactId);
  return value ? { ...value } : undefined;
}

/**
 * `?fake=1&agents=1`: an agent that looks after the first project, answered
 * with a capture of its work and remembered something from it, and told the
 * owner about a thread of that project.
 */
export function seedAgentsDemo(ctx: FakeContext): void {
  const account = ctx.accounts.find(a => a.providerId === 'echo') ?? ctx.accounts[0];
  if (!account) return;
  const project = ctx.projects.find(p => p.kind !== 'drafts') ?? null;
  ctx.agents.seedDemo({
    selection: { providerId: account.providerId, accountId: account.id, model: null, effort: null, permissionMode: 'default' },
    project: project ? { id: project.id, name: project.name } : null,
    attach: threadId => {
      const media = FAKE_MEDIA['assets/preview.png']!;
      const url = media.url();
      const bytes = Math.floor((url.length - url.indexOf(',') - 1) * 3 / 4);
      const id = `artifact-agents-demo-${++ctx.seq}`;
      const name = 'welcome-screen.png';
      const mimeType = url.startsWith('data:image/png') ? 'image/png' : 'image/svg+xml';
      let store = seeded.get(ctx);
      if (!store) seeded.set(ctx, store = new Map());
      store.set(id, { url, bytes, mimeType, name });
      const thread = ctx.thread(threadId);
      const message: Message = { id: `m-${++ctx.seq}`, threadId, turnId: `turn-agents-demo-${ctx.seq}`, role: 'assistant', state: 'complete', createdAt: Date.now() - 2 * 3600_000 + 4 * 60_000,
        parts: [{ type: 'artifact', id, name, mimeType, bytes }] };
      thread.messages.push(message);
      return { threadId, messageId: message.id, part: { type: 'artifact', id, name, mimeType, bytes } };
    },
  });
  askForAnotherProject(ctx);
}

/**
 * The agent asks, from its own conversation, to be entrusted the next project
 * too: a pending agent setting card the conversation draws under its messages.
 */
function askForAnotherProject(ctx: FakeContext): void {
  const session = ctx.agents.snapshot().sessions[0];
  const agent = session ? ctx.agents.profileOf(session.agentId) : null;
  const next = ctx.projects.find(p => p.kind !== 'drafts' && !(agent?.projectIds ?? []).includes(p.id));
  if (!session || !agent || !next) return;
  const thread = ctx.thread(session.threadId);
  const at = Date.now() - 30 * 60_000;
  const turn: Turn = { id: `turn-agents-demo-${++ctx.seq}`, threadId: thread.id, status: 'done', queuedAt: at, startedAt: at, finishedAt: at + 60_000, usage: null, error: null };
  thread.turns.push(turn);
  requestAgentSetting(ctx, thread, turn, { threadId: thread.id, key: 'projects', value: { add: [next.id] }, reason: `${next.name} has threads nobody follows. Entrust it to me and I will watch them the way I watch the others.` });
  // And a sign-in, whose Open shows the page in the conversation: no panel shows that thread.
  requestSignIn(ctx, thread, turn, { threadId: thread.id, reason: 'To read the failed deploy logs on the staging dashboard.', urls: ['https://dashboard.example.com/login'] });
}
