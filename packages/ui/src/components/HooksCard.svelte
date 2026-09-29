<script lang="ts">
  import { untrack } from 'svelte';
  import { ChevronRight, CircleAlert, RefreshCw } from '@lucide/svelte';
  import { RpcErrorCode, type HookRun, type HooksStatus, type ProviderHooks } from '@boite/contracts';
  import { RpcFailure } from '../lib/client';
  import { clockTime, count as figure, exactTime } from '../lib/format';
  import { formatLocale } from '../lib/i18n.svelte';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';
  import ProviderLogo from './ProviderLogo.svelte';

  /**
   * The user's own hooks, per agent: where each one reads them, how many it
   * found, what a separate account misses of them, and since this core
   * started, how many ran and which did not pass. Only a notable run reaches
   * the recent list, so the card stays quiet while everything passes.
   */
  let { store }: { store: Store } = $props();

  /** Newest runs shown open; the rest fold under one row. */
  const SHOWN = 5;

  let status = $state.raw<HooksStatus | null>(null);
  let missing = $state(false);
  let error = $state('');
  let loading = $state(false);
  let revision = 0;

  let running = $derived(status?.providers.filter(provider => provider.runsHooks) ?? []);
  let without = $derived(status?.providers.filter(provider => !provider.runsHooks).map(provider => provider.name) ?? []);
  let names = $derived(new Map(status?.providers.map(provider => [provider.providerId, provider.name]) ?? []));

  async function load() {
    const client = store.client;
    if (!client) return;
    const current = ++revision;
    loading = true;
    try {
      const next = await client.call('hooks.status', {});
      if (current !== revision) return;
      status = next; missing = false; error = '';
    } catch (cause) {
      if (current !== revision) return;
      // An older core has no `hooks.status`: that is a version to update, not a failure.
      if (cause instanceof RpcFailure && cause.code === RpcErrorCode.MethodNotFound) missing = true;
      else error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (current === revision) loading = false;
    }
  }

  $effect(() => {
    const client = store.client;
    if (!client || !store.owner || store.connection !== 'ready') return;
    untrack(() => void load());
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A guard that blocks a loop of tool calls sends a burst: it reads the status once.
    const off = client.on('hooks.changed', () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 300);
    });
    return () => { clearTimeout(timer); off(); ++revision; };
  });

  function plural(one: string, many: string, value: number): string {
    return fill(value === 1 ? one : many, { count: figure(value) });
  }

  /** `13 hooks`, `2 modules`, or why there is no number. */
  function found(provider: ProviderHooks): string {
    const t = strings.hooks;
    const read = provider.sources.filter(source => source.count !== null);
    if (read.length === 0) return t.notFound;
    const hooks = read.filter(source => source.format === 'events').reduce((sum, source) => sum + source.count!, 0);
    const modules = read.filter(source => source.format === 'modules').reduce((sum, source) => sum + source.count!, 0);
    const parts = [
      ...(hooks ? [plural(t.hookOne, t.hookMany, hooks)] : []),
      ...(modules ? [plural(t.moduleOne, t.moduleMany, modules)] : [])
    ];
    return parts.length ? parts.join(', ') : t.none;
  }

  /** The counters since the core started: runs always, the others only when they happened. */
  function counters(provider: ProviderHooks): { kind: 'runs' | 'blocked' | 'failed' | 'skipped'; text: string }[] {
    const t = strings.hooks;
    if (provider.runs === 0) return [{ kind: 'runs', text: t.noRuns }];
    return [
      { kind: 'runs' as const, text: plural(t.runOne, t.runMany, provider.runs) },
      ...(provider.blocked ? [{ kind: 'blocked' as const, text: plural(t.blockedOne, t.blockedMany, provider.blocked) }] : []),
      ...(provider.failed ? [{ kind: 'failed' as const, text: plural(t.failedOne, t.failedMany, provider.failed) }] : []),
      ...(provider.skipped ? [{ kind: 'skipped' as const, text: plural(t.skippedOne, t.skippedMany, provider.skipped) }] : [])
    ];
  }

  /** What needs the user, shown without opening the row: a source it could not read, a file an account misses. */
  function issues(provider: ProviderHooks): { title: string; message: string }[] {
    return [
      ...provider.sources.flatMap(source => source.error ? [{ title: fill(strings.hooks.unreadable, { path: source.path }), message: source.error }] : []),
      ...provider.accounts.flatMap(account => account.problems.map(problem => ({
        title: fill(strings.hooks.accountMisses, { account: account.label, path: problem.path }),
        message: problem.message
      })))
    ];
  }

  function sourceState(source: ProviderHooks['sources'][number]): string {
    const t = strings.hooks;
    if (source.error) return t.sourceError;
    if (source.count === null) return t.sourceMissing;
    return source.format === 'modules' ? plural(t.moduleOne, t.moduleMany, source.count) : plural(t.hookOne, t.hookMany, source.count);
  }

  /** Agent, event, hook. `PreToolUse:Bash` already names its event; a file name does not. */
  function runParts(run: HookRun): string[] {
    const agent = names.get(run.providerId) ?? store.providerOf(run.providerId)?.name ?? run.providerId;
    if (!run.name || run.name === run.event || run.name.startsWith(`${run.event}:`)) return [agent, run.name || run.event];
    return [agent, run.event, run.name];
  }

  function list(values: string[]): string {
    return new Intl.ListFormat(formatLocale(), { type: 'conjunction' }).format(values);
  }
</script>

{#snippet runRow(run: HookRun)}
  <li class="run" data-testid="hooks-run" data-outcome={run.outcome}>
    <div class="run-head">
      <span class="when" title={exactTime(run.at)}>{clockTime(run.at)}</span>
      <!-- Each piece breaks as a whole, so a phone wraps at a dot, not inside `check-branch.sh`. -->
      <span class="what">{#each runParts(run) as part, index (index)}{#if index > 0}{' · '}{/if}<span class="bit">{part}</span>{/each}</span>
      <span class="verdict {run.outcome}">{strings.hooks.outcomes[run.outcome]}</span>
    </div>
    {#if run.message}<p class="message">{run.message}</p>{/if}
  </li>
{/snippet}

<section class="card hooks" id="settings-hooks" data-testid="hooks-card" aria-busy={loading}>
  <h2>{strings.hooks.heading}<InfoTip topic={strings.hooks.heading} text={strings.hooks.description} /></h2>
  {#if status || error}
    <button type="button" class="ghost small icon refresh" aria-label={strings.hooks.refresh} title={strings.hooks.refresh} disabled={loading} onclick={() => void load()} data-testid="hooks-refresh"><RefreshCw size={14} strokeWidth={1.75} /></button>
  {/if}
  {#if missing}
    <p class="hint" data-testid="hooks-missing">{strings.hooks.missing}</p>
  {:else if error}
    <p class="hint error" role="alert">{error}</p>
  {:else if status}
    <div class="providers">
      {#each running as provider (provider.providerId)}
        {@const problems = issues(provider)}
        <div class="provider" data-testid="hooks-provider" data-provider={provider.providerId}>
          <details>
            <summary>
              <ProviderLogo providerId={provider.providerId} size={16} />
              <span class="name">{provider.name}</span>
              <span class="found">{found(provider)}</span>
              {#if provider.reports}
                <span class="counters" data-testid="hooks-counters">
                  {#each counters(provider) as counter, index (counter.kind)}{#if index > 0}{' '}<span class="dot" aria-hidden="true">·</span>{' '}{/if}<span class={counter.kind}>{counter.text}</span>{/each}
                </span>
              {/if}
              <ChevronRight size={14} class="chevron" />
            </summary>
            <div class="detail">
              {#each provider.sources as source (source.path)}
                <div class="source"><code>{source.path}</code><span class:error={source.error}>{sourceState(source)}</span></div>
              {/each}
              {#if !provider.reports}<p>{strings.hooks.configOnly}</p>{/if}
              {#if provider.accounts.length}<p>{plural(strings.hooks.sharedOne, strings.hooks.sharedMany, provider.accounts.length)}</p>{/if}
            </div>
          </details>
          {#each problems as problem, index (index)}
            <div class="issue" data-testid="hooks-issue">
              <CircleAlert size={14} strokeWidth={1.75} />
              <div><p class="issue-title">{problem.title}</p><p>{problem.message}</p></div>
            </div>
          {/each}
        </div>
      {/each}
    </div>
    {#if without.length}
      <p class="without" data-testid="hooks-without">{fill(without.length === 1 ? strings.hooks.withoutOne : strings.hooks.withoutMany, { names: list(without) })}</p>
    {/if}
    <div class="recent-head">
      <h3 class="section-label">{strings.hooks.recent}</h3>
      <span class="since">{fill(strings.hooks.since, { time: clockTime(status.since) })}</span>
    </div>
    {#if status.recent.length === 0}
      <p class="hint" data-testid="hooks-quiet">{strings.hooks.quiet}</p>
    {:else}
      <ol class="runs" data-testid="hooks-recent">
        {#each status.recent.slice(0, SHOWN) as run, index (`${run.at}:${index}`)}{@render runRow(run)}{/each}
      </ol>
      {#if status.recent.length > SHOWN}
        <details class="disclosure more">
          <summary>{fill(strings.hooks.more, { count: figure(status.recent.length - SHOWN) })}</summary>
          <ol class="runs">
            {#each status.recent.slice(SHOWN) as run, index (`${run.at}:${index}`)}{@render runRow(run)}{/each}
          </ol>
        </details>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .hooks { position: relative; margin-top: 28px; }
  /* Beside the title, not under it: the title keeps the card grammar's own air. */
  .refresh { position: absolute; top: calc(var(--settings-padding) + 12px - var(--control-sm) / 2); right: calc(var(--settings-padding) - 6px); }
  p { margin: 0; }
  .error { color: var(--color-danger); overflow-wrap: anywhere; }

  .providers { display: flex; flex-direction: column; container-type: inline-size; }
  .provider + .provider { border-top: 1px solid var(--color-border); }
  summary { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-height: var(--row); padding: 6px 8px; margin: 0 -8px; cursor: pointer; list-style: none; border-radius: var(--radius-md); font-size: var(--text-sm); transition: background var(--dur-2) var(--ease-out-quint); }
  summary::-webkit-details-marker { display: none; }
  summary:hover, summary:focus-visible { background: var(--color-hover); outline: none; }
  summary :global(svg) { flex: none; }
  .name { font-weight: 500; }
  .found { flex: 1; min-width: 0; color: var(--color-muted-foreground); }
  .counters { display: inline-flex; flex-wrap: wrap; gap: 0 6px; color: var(--color-muted-foreground); font-variant-numeric: tabular-nums; }
  .counters .dot { color: var(--color-subtle); }
  .counters .blocked { color: var(--color-foreground); }
  .counters .failed { color: var(--color-danger); }
  .counters .skipped { color: var(--color-live); }
  summary :global(.chevron) { color: var(--color-muted-foreground); transition: transform var(--dur-2) var(--ease-out-quint); }
  details[open] > summary :global(.chevron) { transform: rotate(90deg); }
  /* A phone gives the counters their own line under the name, the chevron staying on the first. */
  @container (max-width: 480px) {
    .counters { order: 1; flex-basis: 100%; padding-left: 26px; }
  }
  .detail { display: grid; gap: 8px; padding: 4px 0 14px 26px; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .source { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 16px; }
  .source code { min-width: 0; font-family: var(--font-mono); font-size: var(--text-sm); color: var(--color-subtle); overflow-wrap: anywhere; }
  .source span { flex: none; }

  /* Under its row, open or not: a file a separate account misses is not something to go looking for. */
  .issue { display: flex; gap: 10px; padding: 2px 0 12px 26px; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .issue :global(svg) { flex: none; margin-top: 2px; color: var(--color-danger); }
  .issue > div { min-width: 0; overflow-wrap: anywhere; }
  .issue-title { color: var(--color-foreground); }

  .without { margin-top: 8px; font-size: var(--text-sm); color: var(--color-subtle); }

  .recent-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 22px 0 8px; }
  .recent-head h3 { margin: 0; }
  .since { font-size: var(--text-xs); color: var(--color-subtle); font-variant-numeric: tabular-nums; }
  .runs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .run { padding: 8px 0; font-size: var(--text-sm); }
  .run + .run { border-top: 1px solid var(--color-border); }
  .run-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; }
  .when { flex: none; color: var(--color-subtle); font-variant-numeric: tabular-nums; }
  .what { flex: 1; min-width: 0; }
  .bit { display: inline-block; max-width: 100%; overflow-wrap: anywhere; }
  .verdict { flex: none; margin-left: auto; font-size: var(--text-xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-muted-foreground); }
  .verdict.blocked { color: var(--color-foreground); }
  .verdict.failed { color: var(--color-danger); }
  .verdict.skipped { color: var(--color-live); }
  .message { margin-top: 2px; color: var(--color-muted-foreground); white-space: pre-wrap; overflow-wrap: anywhere; }
  .more { margin-top: 4px; }
  .more .runs { margin-top: 4px; }
</style>
