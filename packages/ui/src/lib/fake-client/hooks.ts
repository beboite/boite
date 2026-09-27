/** The user's own hooks as the core reports them: where each agent reads them and the runs that did not pass. */
import type { HookRun, HooksStatus, ProviderHooks } from '@boite/contracts';
import type { FakeContext, FakeMethods } from './context';

function provider(fields: Pick<ProviderHooks, 'providerId' | 'name'> & Partial<ProviderHooks>): ProviderHooks {
  return { runsHooks: true, reports: false, sources: [], accounts: [], runs: 0, blocked: 0, failed: 0, skipped: 0, ...fields };
}

/**
 * One of each case the card draws: two agents Boite sees run (Claude, Codex),
 * one with a separate account that misses a file, three it only reads the
 * configuration of, a source that does not exist, and two agents without hooks.
 * Measured from the page's clock, so the recent list reads as today.
 */
export function seedHooks(now = Date.now()): HooksStatus {
  const minutes = (count: number) => now - count * 60_000;
  const recent: HookRun[] = [
    { at: minutes(4), providerId: 'claude', accountId: 'a-claude-main', threadId: null, event: 'UserPromptSubmit', name: 'UserPromptSubmit', outcome: 'blocked', message: 'The prompt holds what looks like an API key. Remove it before sending.' },
    { at: minutes(18), providerId: 'codex', accountId: 'a-codex', threadId: null, event: 'PreToolUse', name: 'check-branch.sh', outcome: 'skipped', message: 'Codex does not run this hook until it is reviewed in Codex.' },
    { at: minutes(26), providerId: 'codex', accountId: 'a-codex', threadId: null, event: 'userPromptSubmit', name: 'userPromptSubmit', outcome: 'blocked', message: 'Pushing to main is off during the release freeze.' },
    { at: minutes(47), providerId: 'claude', accountId: 'a-claude-main', threadId: null, event: 'Stop', name: 'Stop', outcome: 'failed', message: 'stop hook broke: notify.ps1 exited with code 1' },
    { at: minutes(63), providerId: 'claude', accountId: 'a-claude-main', threadId: null, event: 'PreToolUse', name: 'PreToolUse:Bash', outcome: 'blocked', message: 'rm -rf outside the project is blocked by guard.sh.' },
  ];
  return {
    since: minutes(3 * 60 + 12),
    providers: [
      provider({
        providerId: 'claude', name: 'Claude', reports: true,
        sources: [{ path: '~/.claude/settings.json', format: 'events', count: 13, error: null }],
        accounts: [{ accountId: 'a-claude-side', label: 'Second seat', problems: [] }],
        runs: 412, blocked: 2, failed: 1,
      }),
      provider({
        providerId: 'codex', name: 'Codex', reports: true,
        sources: [{ path: '~/.codex/hooks.json', format: 'events', count: 12, error: null }],
        accounts: [{ accountId: 'a-codex-work', label: 'Work', problems: [{ path: 'config.toml', message: 'The copy failed: config.toml is open in another program. Boite tries again at the next turn.' }] }],
        runs: 58, blocked: 1, skipped: 1,
      }),
      provider({
        providerId: 'grok', name: 'Grok',
        sources: [
          { path: '~/.grok/hooks', format: 'events', count: 0, error: null },
          { path: '~/.claude/settings.json', format: 'events', count: 13, error: null },
        ],
      }),
      provider({ providerId: 'pi', name: 'pi', sources: [{ path: '~/.pi/agent/extensions', format: 'modules', count: null, error: null }] }),
      provider({ providerId: 'opencode', name: 'OpenCode', sources: [{ path: '~/.config/opencode/plugins', format: 'modules', count: 2, error: null }] }),
      provider({ providerId: 'antigravity', name: 'Antigravity', runsHooks: false }),
      provider({ providerId: 'echo', name: 'Echo', runsHooks: false }),
    ],
    recent,
  };
}

/**
 * A run that did not pass, as the core records it: newest first, at most 50,
 * the provider's counter moved, and `hooks.changed` for the views that show it.
 */
export function recordHookRun(ctx: FakeContext, run: HookRun): void {
  ctx.hooks.recent = [run, ...ctx.hooks.recent].slice(0, 50);
  const row = ctx.hooks.providers.find(entry => entry.providerId === run.providerId);
  if (row) {
    if (run.outcome === 'skipped') {
      row.skipped += 1;
    } else {
      row.runs += 1;
      if (run.outcome === 'failed') row.failed += 1;
      else if (run.outcome === 'blocked' || run.outcome === 'stopped') row.blocked += 1;
    }
  }
  ctx.emit('hooks.changed', { at: run.at });
}

export function hookMethods(ctx: FakeContext) {
  return {
    'hooks.status': async () => structuredClone(ctx.hooks),
  } satisfies Partial<FakeMethods>;
}
