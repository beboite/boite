<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { ChevronDown, ChevronRight, FileDown, Bug } from '@lucide/svelte';
  import { formatLogDuration, logLevelAtLeast, LOG_LEVELS, type CoreLogLevel, type CoreLogRecord, type CoreLogsQuery, type DiagnosticSummary, type LogOrigin } from '@boite/contracts';
  import InfoTip from './InfoTip.svelte';
  import Menu from './Menu.svelte';
  import DiagnosticsReport from './DiagnosticsReport.svelte';
  import { browserDownload, saveAttachment } from '../lib/attachment-save';
  import { bytes, count, exactTime, millis, relativeTime, time } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * Settings > Diagnostics: the machine's own state, its problems grouped,
   * the log itself with filters, the anonymized export and an issue draft.
   * Owner only: `core.logs` and `diagnostics.*` refuse anyone else.
   */
  let { store, onopenthread }: { store: Store; onopenthread?: () => void } = $props();
  const uid = $props.id();
  const PAGE = 200;
  const KEPT = 2000;
  /** How often an open, visible page reads the records written since its newest. */
  const LIVE_MS = 3000;
  const PERIODS = { '15m': 15 * 60_000, '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 } as const;
  type Period = keyof typeof PERIODS;
  const ORIGINS: LogOrigin[] = ['core', 'shell', 'ui'];
  const s = $derived(strings.diagnostics);

  let summary = $state<DiagnosticSummary | null>(null);
  let failure = $state('');
  let records = $state<CoreLogRecord[]>([]);
  let loading = $state(false);
  let older = $state(false);
  let minLevel = $state<CoreLogLevel>('info');
  let origin = $state<LogOrigin | null>(null);
  let threadId = $state<string | null>(null);
  let typed = $state('');
  let search = $state('');
  let period = $state<Period>('24h');
  const open = new SvelteSet<string>();
  const openProblems = new SvelteSet<string>();
  let list = $state<HTMLDivElement>();
  let exporting = $state(false);
  let exportNote = $state('');
  let reporting = $state(false);

  // The search waits for a pause in the typing rather than asking on every key.
  $effect(() => {
    const value = typed.trim();
    const timer = setTimeout(() => { search = value; }, 300);
    return () => clearTimeout(timer);
  });

  let query = $derived<Omit<CoreLogsQuery, 'limit'>>({
    minLevel,
    ...(origin ? { origin } : {}),
    ...(threadId ? { threadId } : {}),
    ...(search ? { search: search.slice(0, 200) } : {})
  });

  function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  // The status and the problems: once per connection.
  $effect(() => {
    const client = store.client;
    if (!client || !store.owner || store.connection !== 'ready') return;
    let active = true;
    failure = '';
    client.call('diagnostics.summary', {})
      .then(value => { if (active) summary = value; })
      .catch(error => { if (active) failure = fill(s.failed, { reason: reason(error) }); });
    return () => { active = false; };
  });

  /** The newest page of the filters, oldest first so the newest sits at the bottom. */
  $effect(() => {
    const client = store.client;
    const filters = query;
    const since = Date.now() - PERIODS[period];
    if (!client || !store.owner || store.connection !== 'ready') return;
    let active = true;
    loading = true;
    open.clear();
    client.call('core.logs', { ...filters, since, limit: PAGE })
      .then(page => {
        if (!active) return;
        records = page.slice().reverse();
        older = page.length === PAGE;
        void tick().then(() => { if (list) list.scrollTop = list.scrollHeight; });
      })
      .catch(error => { if (active) { records = []; failure = fill(s.failed, { reason: reason(error) }); } })
      .finally(() => { if (active) loading = false; });
    return () => { active = false; };
  });

  // New records while the page is open and visible, read back every few seconds:
  // what the shell and the clients wrote too, with each record's own id, origin
  // and agent, which the live core.log event does not carry.
  $effect(() => {
    const client = store.client;
    const filters = query;
    if (!client || !store.owner || store.connection !== 'ready') return;
    let active = true;
    let reading = false;
    const poll = async (): Promise<void> => {
      if (!active || reading || loading || document.visibilityState !== 'visible') return;
      reading = true;
      try {
        const newest = untrack(() => records.at(-1)?.at) ?? Date.now() - PERIODS[untrack(() => period)];
        const page = await client.call('core.logs', { ...filters, since: newest, limit: PAGE });
        if (!active || page.length === 0) return;
        const known = new Set(untrack(() => records).map(record => record.id));
        const fresh = page.filter(record => !known.has(record.id)).reverse();
        if (fresh.length === 0) return;
        const element = list;
        const atBottom = element ? element.scrollHeight - element.scrollTop - element.clientHeight < 24 : true;
        records = [...untrack(() => records), ...fresh].slice(-KEPT);
        if (atBottom) void tick().then(() => { if (element) element.scrollTop = element.scrollHeight; });
      } catch { /* The next read tries again; the page keeps what it shows. */ }
      finally { reading = false; }
    };
    const timer = setInterval(() => void poll(), LIVE_MS);
    return () => { active = false; clearInterval(timer); };
  });

  async function loadOlder() {
    const client = store.client;
    const first = records[0];
    if (!client || !first || loading) return;
    loading = true;
    const element = list;
    const before = element ? element.scrollHeight - element.scrollTop : 0;
    try {
      const page = await client.call('core.logs', { ...query, since: Date.now() - PERIODS[period], until: first.at, limit: PAGE });
      if (store.client !== client) return;
      const known = new Set(records.map(record => record.id));
      const fresh = page.filter(record => !known.has(record.id)).reverse();
      records = [...fresh, ...records];
      older = page.length === PAGE && fresh.length > 0;
      // The rows already read stay under the eye; the older ones grow above.
      void tick().then(() => { if (element) element.scrollTop = element.scrollHeight - before; });
    } catch (error) {
      failure = fill(s.failed, { reason: reason(error) });
    } finally { loading = false; }
  }

  function threadTitle(id: string): string | null {
    return store.threads.find(thread => thread.id === id)?.title ?? null;
  }

  function openThread(id: string) {
    const owner = store;
    onopenthread?.();
    void owner.open(id);
  }

  let levelItems = $derived(LOG_LEVELS.map(level => ({ id: level, label: s.atLeast[level], active: level === minLevel })));
  let originItems = $derived([{ id: 'all', label: s.origins.all, active: origin === null }, ...ORIGINS.map(id => ({ id, label: s.origins[id], active: origin === id }))]);
  let periodItems = $derived((Object.keys(PERIODS) as Period[]).map(id => ({ id, label: s.periods[id], active: id === period })));
  let threadItems = $derived([
    { id: '', label: s.allThreads, active: threadId === null },
    ...store.threads.filter(thread => !thread.archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40)
      .map(thread => ({ id: thread.id, label: thread.title || thread.id, active: thread.id === threadId }))
  ]);
  let threadLabel = $derived(threadId === null ? s.allThreads : threadTitle(threadId) ?? threadId);

  /** The day only when it is not today: most of what is read here is from the last hours. */
  function stamp(at: number): string {
    return new Date(at).toDateString() === new Date().toDateString() ? time(at) : `${exactTime(at)}`;
  }

  function who(record: CoreLogRecord): string {
    if (!record.providerId) return '';
    return record.model ? `${record.providerId}/${record.model}` : record.providerId;
  }

  async function exportLogs() {
    const client = store.client;
    if (!client || exporting) return;
    exporting = true;
    exportNote = '';
    try {
      const result = await client.call('diagnostics.export', {});
      if (store.client !== client) return;
      const body = new TextEncoder().encode(result.text);
      const size = bytes(body.byteLength);
      const saved = await saveAttachment(result.name, body, false);
      if (saved) { exportNote = fill(s.exportDone, { name: result.name, size }); return; }
      const file = new File([body], result.name, { type: 'text/plain' });
      // A phone hands the file to the share sheet when it can; anything else downloads it.
      if (window.matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: result.name }); exportNote = fill(s.exportDone, { name: result.name, size }); return; }
        catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return; }
      }
      const url = URL.createObjectURL(file);
      browserDownload(url, result.name);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      exportNote = fill(s.exportDownloaded, { name: result.name, size });
    } catch (error) {
      if (store.client === client) exportNote = reason(error);
    } finally { exporting = false; }
  }

  async function toggleAgents(input: HTMLInputElement) {
    const ok = await store.saveSettings({ agentLogAccess: input.checked });
    if (!ok) input.checked = store.settings?.agentLogAccess ?? !input.checked;
  }

  let environment = $derived(summary?.environment ?? null);
  let errorsFirst = $derived(summary ? summary.problems.slice().sort((a, b) => (b.level === 'error' ? 1 : 0) - (a.level === 'error' ? 1 : 0) || b.lastAt - a.lastAt) : []);
</script>

{#if store.owner}
<div class="page diagnostics" data-testid="diagnostics-page">
  <header>
    <div>
      <h1 class="ui-label-box"><span class="ui-label">{s.heading}</span><InfoTip topic={s.heading} text={s.intro} /></h1>
    </div>
  </header>

  {#if failure}<p class="hint alert" role="alert">{failure}</p>{/if}

  <section class="card" id="settings-diagnostics-status" data-testid="diagnostics-status">
    <h2>{s.status}</h2>
    {#if environment && summary}
      <dl class="facts">
        <div><dt>{s.version}</dt><dd>{environment.version} · {environment.channel}</dd></div>
        <div><dt>{s.system}</dt><dd>{environment.platform} {environment.osRelease} · {environment.arch}</dd></div>
        <div><dt>{s.uptime}</dt><dd>{millis(environment.uptimeMs)}</dd></div>
        <div>
          <dt>{s.lastDay}</dt>
          <dd class="counts" data-testid="diagnostics-counts">
            {#each [...LOG_LEVELS].reverse() as level (level)}
              <span class="count" data-level={level}><strong>{count(summary.counts[level])}</strong> {s.levels[level]}</span>
            {/each}
          </dd>
        </div>
        <div>
          <dt>{s.files}</dt>
          <dd>
            {#if summary.logFiles.length === 0}{s.noFiles}{:else}
              <ul class="files">{#each summary.logFiles as file (file.name)}<li><code>{file.name}</code> <span>{bytes(file.bytes)}</span></li>{/each}</ul>
            {/if}
          </dd>
        </div>
      </dl>
    {:else if !failure}
      <p class="hint">{s.loading}</p>
    {/if}
    <div class="actions buttons">
      <button type="button" data-testid="diagnostics-export" disabled={exporting || store.connection !== 'ready'} onclick={() => void exportLogs()}><FileDown size={15} /><span class="ui-label">{s.export}</span></button>
      <button type="button" data-testid="diagnostics-report" disabled={store.connection !== 'ready'} onclick={() => { reporting = true; }}><Bug size={15} /><span class="ui-label">{s.report}</span></button>
      <InfoTip topic={s.export} text={`${s.exportHint} ${s.reportHint}`} />
    </div>
    {#if exportNote}<p class="hint note" data-testid="diagnostics-export-note">{exportNote}</p>{/if}
  </section>

  <section class="card" id="settings-diagnostics-problems" data-testid="diagnostics-problems">
    <h2 class="ui-label-box"><span class="ui-label">{s.problems}</span><InfoTip topic={s.problems} text={s.problemsHint} /></h2>
    {#if summary && errorsFirst.length === 0}
      <p class="hint">{s.problemsEmpty}</p>
    {:else}
      <ul class="problems">
        {#each errorsFirst as problem (`${problem.origin}|${problem.source}|${problem.event}|${problem.level}`)}
          {@const key = `${problem.origin}|${problem.source}|${problem.event}|${problem.level}`}
          {@const expanded = openProblems.has(key)}
          <li>
            <button type="button" class="ghost problem" aria-expanded={expanded} data-testid="diagnostics-problem" onclick={() => { if (expanded) openProblems.delete(key); else openProblems.add(key); }}>
              <ChevronRight size={14} class={expanded ? 'turned' : ''} />
              <span class="level" data-level={problem.level}>{problem.level}</span>
              <span class="name"><code>{problem.origin}/{problem.source}/{problem.event}</code></span>
              <span class="meta"><span class="times">{fill(s.times, { count: count(problem.count) })}</span><span class="when" title={exactTime(problem.lastAt)}>{fill(s.lastSeen, { time: relativeTime(problem.lastAt) })}</span></span>
            </button>
            {#if expanded}
              <div class="problem-detail">
                <p class="latest"><span class="label">{s.latest}</span>{problem.message}</p>
                {#if problem.threadIds.length > 0}
                  <p class="label">{s.threads}</p>
                  <ul class="thread-links">
                    {#each problem.threadIds as id (id)}
                      {@const title = threadTitle(id)}
                      <li>
                        {#if title !== null}
                          <button type="button" class="quiet link" onclick={() => openThread(id)}><span class="ui-label">{title}</span> <code>{id}</code></button>
                        {:else}
                          <code>{id}</code> <span class="muted">{s.missingThread}</span>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="card log-card" id="settings-diagnostics-log" data-testid="diagnostics-log">
    <h2 class="ui-label-box"><span class="ui-label">{s.log}</span><InfoTip topic={s.log} text={s.live} /></h2>
    <div class="filters">
      <Menu items={levelItems} label={s.level} placement="bottom" testid="diagnostics-level" onpick={id => { minLevel = id as CoreLogLevel; }}>
        <span class="ui-label">{s.atLeast[minLevel]}</span><ChevronDown size={13} />
      </Menu>
      <Menu items={originItems} label={s.origin} placement="bottom" testid="diagnostics-origin" onpick={id => { origin = id === 'all' ? null : id as LogOrigin; }}>
        <span class="ui-label">{origin ? s.origins[origin] : s.origins.all}</span><ChevronDown size={13} />
      </Menu>
      <Menu items={threadItems} label={s.thread} placement="bottom" testid="diagnostics-thread" onpick={id => { threadId = id === '' ? null : id; }}>
        <span class="ui-label thread-pick">{threadLabel}</span><ChevronDown size={13} />
      </Menu>
      <Menu items={periodItems} label={s.period} placement="bottom" testid="diagnostics-period" onpick={id => { period = id as Period; }}>
        <span class="ui-label">{s.periods[period]}</span><ChevronDown size={13} />
      </Menu>
      <input class="search" type="search" bind:value={typed} placeholder={s.search} aria-label={s.search} data-testid="diagnostics-search" spellcheck="false" autocomplete="off" />
    </div>

    <div class="rows" bind:this={list} data-testid="diagnostics-rows" aria-busy={loading}>
      {#if older}
        <button type="button" class="ghost older" disabled={loading} data-testid="diagnostics-older" onclick={() => void loadOlder()}><span class="ui-label">{s.loadOlder}</span></button>
      {:else if records.length > 0}
        <p class="edge">{s.noOlder}</p>
      {/if}
      {#if records.length === 0 && !loading}
        <p class="edge" data-testid="diagnostics-empty">{s.empty}</p>
      {/if}
      {#each records as record (record.id)}
        {@const expanded = open.has(record.id)}
        <div class="record" class:expanded data-level={record.level}>
          <button type="button" class="ghost line" aria-expanded={expanded} id="{uid}-{record.id}" data-testid="diagnostics-record" onclick={() => { if (expanded) open.delete(record.id); else open.add(record.id); }}>
            <span class="time" title={exactTime(record.at)}>{stamp(record.at)}</span>
            <span class="level" data-level={record.level}>{record.level}</span>
            <span class="origin">{record.origin ?? 'core'}</span>
            <span class="what"><code>{record.source}/{record.event}</code>{#if record.threadId}<code class="thread">{record.threadId}{who(record) ? ` ${who(record)}` : ''}</code>{/if}{#if record.durationMs !== undefined}<span class="duration">{formatLogDuration(record.durationMs)}</span>{/if}</span>
            <span class="message">{record.message}</span>
          </button>
          {#if expanded}
            <dl class="detail">
              {#if record.durationMs !== undefined}<div><dt>{s.duration}</dt><dd>{formatLogDuration(record.durationMs)}</dd></div>{/if}
              {#if who(record)}<div><dt>{s.agent}</dt><dd>{who(record)}</dd></div>{/if}
              <div><dt>{s.ids}</dt><dd class="ids">
                {#if record.threadId}<span>thread <code>{record.threadId}</code>{#if threadTitle(record.threadId) !== null} <button type="button" class="quiet link" onclick={() => openThread(record.threadId!)}><span class="ui-label">{threadTitle(record.threadId)}</span></button>{/if}</span>{/if}
                {#if record.parentThreadId}<span>{s.parent} <code>{record.parentThreadId}</code></span>{/if}
                {#if record.turnId}<span>turn <code>{record.turnId}</code></span>{/if}
                {#if record.requestId}<span>request <code>{record.requestId}</code></span>{/if}
                {#if record.runId}<span>run <code>{record.runId}</code></span>{/if}
              </dd></div>
              {#if record.data && Object.keys(record.data).length > 0}
                <div><dt>{s.details}</dt><dd><ul class="data">{#each Object.entries(record.data) as [key, value] (key)}<li><code>{key}</code> {String(value)}</li>{/each}</ul></dd></div>
              {/if}
            </dl>
          {/if}
        </div>
      {/each}
    </div>
  </section>

  <section class="card" id="settings-diagnostics-agents">
    <label for="{uid}-agents" class="switch-row">
      <span class="text ui-label-box"><span class="ui-label" id="{uid}-agents-name">{s.agentAccess}</span><InfoTip topic={s.agentAccess} text={s.agentAccessHint} /></span>
      <input id="{uid}-agents" aria-labelledby="{uid}-agents-name" type="checkbox" role="switch" data-testid="setting-agent-log-access"
        checked={store.settings?.agentLogAccess ?? true} disabled={!store.settings} onchange={event => void toggleAgents(event.currentTarget)} />
    </label>
  </section>
</div>

{#if reporting}<DiagnosticsReport {store} onclose={() => { reporting = false; }} />{/if}
{/if}

<style>
  .alert { color: var(--color-danger); max-width: var(--settings-width); margin-bottom: 16px; overflow-wrap: anywhere; }
  .facts { display: grid; gap: 12px; margin: 0; }
  .facts > div { display: grid; grid-template-columns: 160px 1fr; gap: 12px; align-items: baseline; }
  dt { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .counts { display: flex; flex-wrap: wrap; gap: 6px 16px; }
  .count { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .count strong { color: var(--color-foreground); font-weight: 600; font-variant-numeric: tabular-nums; }
  .count[data-level='error'] strong { color: var(--color-danger); }
  .files { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; font-size: var(--text-sm); }
  .files span { color: var(--color-muted-foreground); }
  code { font-family: var(--font-mono); font-size: var(--text-xs); }
  .buttons { margin-top: 18px; }
  .buttons button { gap: 6px; }
  .note { margin-top: 10px; overflow-wrap: anywhere; }

  .problems { display: grid; margin: 0; padding: 0; list-style: none; }
  .problems > li + li { border-top: 1px solid var(--color-border); }
  .problem { display: flex; align-items: center; gap: 10px; width: 100%; height: auto; min-height: var(--row); padding: 6px 4px; text-align: left; color: var(--color-foreground); border-radius: var(--radius-sm); }
  .problem :global(svg) { flex: none; color: var(--color-subtle); transition: transform var(--dur-2) var(--ease-out-quint); }
  .problem :global(.turned) { transform: rotate(90deg); }
  .problem .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { flex: none; display: flex; gap: 10px; }
  .times, .when { font-size: var(--text-sm); color: var(--color-muted-foreground); font-variant-numeric: tabular-nums; }
  .problem-detail { padding: 4px 4px 12px 28px; display: grid; gap: 6px; }
  .label { display: block; font-size: var(--text-xs); color: var(--color-muted-foreground); margin-bottom: 2px; }
  .latest { margin: 0; overflow-wrap: anywhere; line-height: 1.5; }
  .thread-links { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .muted { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .link { height: auto; padding: 0; gap: 6px; color: var(--color-foreground); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--color-edge); }

  .level { flex: none; display: inline-block; min-width: 44px; font-family: var(--font-mono); font-size: var(--text-xs); text-transform: uppercase; color: var(--color-muted-foreground); }
  .level[data-level='error'] { color: var(--color-danger); font-weight: 600; }
  .level[data-level='warn'] { color: color-mix(in srgb, var(--color-danger) 55%, var(--color-muted-foreground)); font-weight: 600; }
  .level[data-level='debug'] { color: var(--color-subtle); }

  .log-card { padding-bottom: 0; }
  .filters { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 12px; }
  .thread-pick { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .search { flex: 1 1 160px; min-width: 0; height: var(--control-sm); font-size: var(--text-sm); }
  .rows { max-height: min(60vh, 560px); overflow: auto; margin: 0 calc(-1 * var(--settings-padding)); border-top: 1px solid var(--color-border); overscroll-behavior: contain; }
  .edge { padding: 10px var(--settings-padding); margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .older { width: 100%; height: auto; min-height: var(--row); border-radius: 0; font-size: var(--text-sm); }
  .record + .record { border-top: 1px solid var(--color-border); }
  .record.expanded { background: var(--color-hover); }
  .line { display: grid; grid-template-columns: auto auto auto minmax(0, 1fr); grid-template-areas: 'time level origin what' 'message message message message'; column-gap: 10px; row-gap: 2px; width: 100%; height: auto; padding: 6px var(--settings-padding); text-align: left; border-radius: 0; color: var(--color-foreground); white-space: normal; font-weight: normal; }
  .time { grid-area: time; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-muted-foreground); font-variant-numeric: tabular-nums; }
  .line .level { grid-area: level; min-width: 0; }
  .origin { grid-area: origin; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-subtle); }
  .what { grid-area: what; display: flex; gap: 8px; min-width: 0; overflow: hidden; white-space: nowrap; color: var(--color-muted-foreground); }
  .what code { overflow: hidden; text-overflow: ellipsis; }
  .what .thread { flex: 0 1 auto; color: var(--color-subtle); }
  .duration { flex: none; font-size: var(--text-xs); }
  .message { grid-area: message; font-size: var(--text-sm); line-height: 1.45; overflow-wrap: anywhere; }
  .record:not(.expanded) .message { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .detail { display: grid; gap: 6px; margin: 0; padding: 2px var(--settings-padding) 12px; }
  .detail > div { display: grid; grid-template-columns: 110px 1fr; gap: 10px; align-items: baseline; }
  .ids { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: var(--text-sm); }
  .data { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; font-size: var(--text-sm); overflow-wrap: anywhere; }
  .data code { color: var(--color-muted-foreground); }
  /* A provider's stderr tail keeps its own lines. */
  .data li { white-space: pre-wrap; }

  @media (max-width: 720px) {
    .facts > div, .detail > div { grid-template-columns: 1fr; gap: 2px; }
    .problem { display: grid; grid-template-columns: auto auto minmax(0, 1fr); grid-template-areas: 'chevron level name' '. . meta'; column-gap: 8px; row-gap: 2px; }
    .problem > :global(svg) { grid-area: chevron; }
    .problem .level { grid-area: level; min-width: 0; }
    .problem .name { grid-area: name; }
    .problem .meta { grid-area: meta; }
    .problem-detail { padding-left: 22px; }
    .line { grid-template-columns: auto auto minmax(0, 1fr); grid-template-areas: 'time level origin' 'what what what' 'message message message'; }
    .search { flex-basis: 100%; }
  }
  @media (prefers-reduced-motion: reduce) { .problem :global(svg) { transition: none; } }
</style>
