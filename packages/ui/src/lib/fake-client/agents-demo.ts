import type { AgentMessageFile, ArtifactContent, Message } from '@boite/contracts';
import type { FakeContext } from './context';
import { FAKE_MEDIA } from './files';

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
}
