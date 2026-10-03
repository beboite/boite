import type { FakeContext } from '../../packages/ui/src/lib/fake-client/context';
import { FAKE_CHANGES, FAKE_DIFFS } from '../../packages/ui/src/lib/fake-client/files';

/** Public sample data, loaded only by the recorder's isolated Vite server. */
export function seedReadme(ctx: FakeContext): void {
  const at = Date.now() - 10 * 60_000;
  ctx.projects[0]!.name = 'Orbit';
  ctx.projects[0]!.path = '/projects/orbit';
  ctx.projects[1]!.name = 'Field notes';
  ctx.projects[1]!.path = '/projects/field-notes';
  const titles: Record<string, string> = {
    't-trace': 'Build the launch page',
    't-scheduler': 'Review the API',
    't-bench': 'Add keyboard navigation',
    't-descriptors': 'Plan the next release',
    't-team-running': 'Check accessibility',
    't-team-done': 'Review the layout',
  };
  for (const [id, thread] of ctx.threads) {
    if (!titles[id] && !thread.parentThreadId) ctx.threads.delete(id);
  }
  ctx.pendingPermissions.clear();
  ctx.pendingQuestions.clear();
  for (const thread of ctx.threads.values()) {
    thread.title = titles[thread.id] ?? thread.title;
    thread.cwd = thread.projectId === 'p-notes' ? '/projects/field-notes' : '/projects/orbit';
    thread.createdAt = at; thread.updatedAt = at + 41_000;
    thread.lastUserMessageAt = at;
    thread.status = 'idle'; thread.load = null;
    thread.memoryEvents = []; thread.promptCache = undefined;
    thread.pullRequest = null;
    for (const turn of thread.turns) {
      turn.status = 'done'; turn.queuedAt = at;
      turn.startedAt = at; turn.finishedAt = at + 41_000;
    }
    for (const message of thread.messages) message.createdAt = at;
  }
  const root = ctx.thread('t-trace');
  ctx.workflows.forget(root.id);
  root.providerId = 'claude';
  root.accountId = ctx.accounts.find(a => a.providerId === 'claude')!.id;
  root.model = 'claude-sonnet-5';
  root.effort = 'high'; root.branch = 'orbit/launch-page';
  const turnId = root.turns[0]!.id;
  root.messages = [
    { id: 'film-user', threadId: root.id, turnId, role: 'user', state: 'complete', createdAt: at, parts: [
      { type: 'text', text: 'Build the launch page. Add an email signup and make it work on mobile.' },
    ] },
    { id: 'film-answer', threadId: root.id, turnId, role: 'assistant', state: 'complete', createdAt: at + 1000, parts: [
      { type: 'tool', toolId: 'film-read', name: 'Read', input: { path: 'src/routes/+page.svelte' }, output: 'Launch page loaded.', status: 'done' },
      { type: 'tool', toolId: 'film-check', name: 'Bash', input: { command: 'bun run check' }, output: 'All checks passed.', status: 'done' },
      { type: 'text', text: '### The launch page is ready\n\nAdded the email signup with a visible label and keyboard focus. The layout stacks on smaller screens.\n\nThe accessibility and layout reviews are complete. Open **Changes** to review the diff.' },
    ] },
  ];
  for (const row of ctx.delegationAgents.get(root.id) ?? []) {
    row.task = row.profileId === 'reviewer' ? 'Check the signup label and keyboard focus.' : 'Check the layout at desktop and phone widths.';
    const child = ctx.thread(row.threadId);
    child.createdAt = at + 10_000;
    for (const turn of child.turns) {
      turn.queuedAt = at + 10_000; turn.startedAt = at + 10_000;
    }
    for (const message of child.messages) {
      message.state = 'complete'; message.createdAt = at + 20_000;
      message.parts = [{ type: 'text', text: message.role === 'user' ? row.task : 'Review complete. No changes needed.' }];
    }
  }
  FAKE_CHANGES.splice(0, FAKE_CHANGES.length,
    { path: 'src/routes/+page.svelte', status: 'modified', oldPath: null, staged: false, additions: 11, deletions: 0 },
    { path: 'src/app.css', status: 'modified', oldPath: null, staged: false, additions: 6, deletions: 0 },
  );
  const before = '<section class="launch">\n  <h1>Make room for your next idea.</h1>\n  <p>A workspace for the things you want to build.</p>\n</section>\n';
  FAKE_DIFFS['src/routes/+page.svelte'] = {
    oldText: before,
    newText: before.replace('</section>', '\n  <form method="POST" class="signup">\n    <label for="email">Get the launch email</label>\n    <div class="signup-row">\n      <input\n        id="email" name="email" type="email"\n        autocomplete="email" required\n      />\n      <button type="submit">Keep me posted</button>\n    </div>\n  </form>\n</section>'),
    binary: false, truncated: false,
  };
  FAKE_DIFFS['src/app.css'] = {
    oldText: '.launch { max-width: 64rem; margin: auto; }\n',
    newText: '.launch { max-width: 64rem; margin: auto; }\n\n.signup-row { display: flex; gap: 0.75rem; }\n\n@media (width < 40rem) {\n  .signup-row { flex-direction: column; }\n}\n',
    binary: false, truncated: false,
  };
}
