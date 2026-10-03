import type { FakeContext } from '../../packages/ui/src/lib/fake-client/context';

/** Public sample data for the film, injected only by the recording server. */
export function seedReadme(ctx: FakeContext): void {
  ctx.providers.find(p => p.id === 'codex')!.models = [{
    id: 'gpt-6-astra', name: 'GPT-6 Astra', default: true,
    effort: { levels: [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }], default: 'high' },
  }];
  ctx.projects[0]!.name = 'Orbit';
  ctx.projects[0]!.path = '/projects/orbit';
  ctx.projects[1]!.name = 'Field notes';
  ctx.projects[1]!.path = '/projects/field-notes';
  const titles: Record<string, string> = {
    't-trace': 'Polish the launch page',
    't-scheduler': 'Review the API',
    't-bench': 'Add keyboard navigation',
    't-descriptors': 'Plan the next release',
    't-team-running': 'Check accessibility',
    't-team-done': 'Review the component',
  };
  for (const [id, thread] of ctx.threads) {
    if (!titles[id] && !thread.parentThreadId) ctx.threads.delete(id);
  }
  for (const thread of ctx.threads.values()) {
    thread.title = titles[thread.id] ?? thread.title;
    thread.cwd = thread.projectId === 'p-notes' ? '/projects/field-notes' : '/projects/orbit';
    thread.memoryEvents = [];
    thread.promptCache = undefined;
    thread.pullRequest = null;
  }
  const root = ctx.thread('t-trace');
  ctx.workflows.forget(root.id);
  const account = ctx.accounts.find(a => a.providerId === 'claude')!;
  root.providerId = 'claude'; root.accountId = account.id;
  root.model = ctx.providers.find(p => p.id === 'claude')!.models.find(m => m.default)?.id ?? 'claude-fable-5-1';
  root.effort = 'high'; root.branch = 'boite/polish-launch-page';
  const turnId = root.turns[0]!.id;
  root.messages = [
    { id: 'film-user', threadId: root.id, turnId, role: 'user', state: 'complete', createdAt: root.createdAt, parts: [{ type: 'text', text: 'Polish the launch page. Keep it accessible, check the mobile layout, and show me the changes.' }] },
    { id: 'film-answer', threadId: root.id, turnId, role: 'assistant', state: 'complete', createdAt: root.createdAt + 1000, parts: [
      { type: 'thinking', text: 'I will inspect the component, improve the spacing, and check keyboard focus before reviewing the diff.' },
      { type: 'tool', toolId: 'film-read', name: 'Read', input: { path: 'src/components/RightPanel.svelte' }, output: 'Component and styles loaded.', status: 'done' },
      { type: 'tool', toolId: 'film-test', name: 'Bash', input: { command: 'bun run check' }, output: 'All checks passed.', status: 'done' },
      { type: 'text', text: '### Ready for a closer look\n\nThe launch page has clearer spacing and visible keyboard focus. The layout adapts from desktop to phone.\n\n- Kept the existing color tokens.\n- Checked headings and button labels.\n- Reviewed the component changes in the panel.\n\nOpen **Changes** to inspect the diff, or **Subagents** to follow the review.' },
    ] },
  ];
  for (const row of ctx.delegationAgents.get(root.id) ?? []) {
    row.task = row.profileId === 'reviewer' ? 'Check keyboard focus and small-screen spacing.' : 'Review the component changes and report regressions.';
  }
  const running = ctx.threads.get('t-team-running');
  if (running) {
    running.messages[0]!.parts = [{ type: 'text', text: 'Check keyboard focus and small-screen spacing.' }];
    running.messages[1]!.parts = [{ type: 'text', text: 'Keyboard focus is visible. I am checking the phone layout and heading order.' }];
  }
  const done = ctx.threads.get('t-team-done');
  if (done) {
    done.messages[0]!.parts = [{ type: 'text', text: 'Review the component changes and report regressions.' }];
    done.messages[1]!.parts = [{ type: 'text', text: 'The component review is complete. Spacing and button labels are consistent.' }];
  }
  ctx.todos = [
    { id: 'film-task-1', projectId: 'p-boite', text: 'Polish the launch page', status: 'claimed', threadId: root.id, createdAt: root.createdAt, updatedAt: root.updatedAt },
    { id: 'film-task-2', projectId: 'p-boite', text: 'Review keyboard navigation', status: 'open', threadId: null, createdAt: root.createdAt, updatedAt: root.updatedAt },
  ];
}
