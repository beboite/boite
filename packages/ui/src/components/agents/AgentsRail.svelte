<script lang="ts">
  import { ArrowLeft, Bell, Ellipsis, Search, Settings2, SquarePen, UserRoundPlus, Users } from '@lucide/svelte';
  import { chatKey, previewOf, type AgentChat, type AgentEntryKind, type AgentFocus, type AgentsView } from '../../lib/agents.svelte';
  import { ago } from '../../lib/format';
  import { separator, type MenuItem } from '../../lib/menu';
  import { fill, strings } from '../../lib/strings';
  import { workspace } from '../../lib/workspace.svelte';
  import Menu from '../Menu.svelte';
  import AgentAvatar from './AgentAvatar.svelte';

  let { view, chats, active, attention, onfocus, oncreate }: {
    view: AgentsView;
    chats: AgentChat[];
    /** The row the open conversation belongs to. */
    active: string | null;
    attention: number;
    onfocus: (focus: AgentFocus) => void;
    oncreate: (kind: AgentEntryKind) => void;
  } = $props();

  /** Past this many rows the list gets its search field. */
  const SEARCH_FROM = 6;
  const labels = $derived(strings.agents);
  let query = $state('');
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  const snapshot = $derived(view.snapshot);
  const profiles = $derived(new Map(snapshot?.profiles.map(a => [a.id, a]) ?? []));
  const needle = $derived(query.trim().toLowerCase());
  const shown = $derived(needle ? chats.filter(c => c.name.toLowerCase().includes(needle)) : chats);
  /** A search also reaches what the list leaves out: archived agents and missions. */
  const found = $derived(needle && snapshot ? [
    ...snapshot.profiles.filter(a => a.status === 'archived' && a.name.toLowerCase().includes(needle)).map(a => ({ kind: 'profile' as const, id: a.id, name: a.name, avatar: a.avatar, state: labels.archived })),
    ...snapshot.missions.filter(m => m.title.toLowerCase().includes(needle)).map(m => ({ kind: 'mission' as const, id: m.id, name: m.title, avatar: '', state: labels[m.status] }))
  ] : []);
  const counts = $derived({
    running: snapshot?.work.filter(w => w.status === 'running').length ?? 0,
    pending: snapshot?.work.filter(w => w.status === 'pending').length ?? 0,
    paused: snapshot?.limits.paused ?? false
  });
  const machine = $derived(workspace.machines.find(m => m.store === view.store));
  const multi = $derived(workspace.machines.length > 1);
  const more = $derived<MenuItem[]>([
    ...(multi ? [...workspace.machines.map(m => ({ id: `machine:${m.id}`, label: m.label, active: m.store === view.store })), ...(view.store.owner ? [separator()] : [])] : []),
    ...(view.store.owner ? [{ id: 'engine', label: labels.engineSettings, glyph: Settings2 }] : [])
  ]);

  function memberList(chat: AgentChat) {
    return chat.members.flatMap(id => profiles.get(id) ?? []);
  }
  function preview(chat: AgentChat): string {
    if (chat.status === 'waiting' || chat.status === 'running') return labels[chat.status];
    const last = chat.last;
    if (last) {
      const text = previewOf(last.text);
      const sender = last.senderId === null ? labels.user : chat.kind === 'profile' ? '' : profiles.get(last.senderId)?.name ?? '';
      return sender ? fill(labels.previewFrom, { name: sender, text }) : text;
    }
    if (chat.kind === 'profile') return profiles.get(chat.id)?.domain ?? '';
    return memberList(chat).map(a => a.name).join(', ');
  }
  function pickMore(id: string) {
    if (id === 'engine') { onfocus({ kind: 'engine' }); return; }
    const target = workspace.machines.find(m => `machine:${m.id}` === id);
    if (target) void workspace.select(target.store).then(() => target.store.showAgents());
  }
</script>

<aside class="agents-rail" aria-label={labels.heading}>
  <header>
    <button type="button" class="ghost icon agents-leave" aria-label={labels.back} title={labels.back} onclick={() => view.store.showChat()}><ArrowLeft size={16} strokeWidth={1.75} /></button>
    <h1>{labels.heading}</h1>
    {#if multi}<span class="agents-machine">{machine?.label ?? view.store.core?.hostname ?? strings.machines.local}</span>{/if}
    <span class="agents-grow"></span>
    {#if more.length}
      <Menu placement="bottom" align="end" variant="ghost" label={labels.more} testid="agents-more" items={more} onpick={pickMore}><Ellipsis size={16} strokeWidth={1.75} /></Menu>
    {/if}
    {#if view.store.owner}
      <Menu placement="bottom" align="end" variant="ghost" label={labels.create} testid="agents-create" items={[{ id: 'profile', label: labels.newTitle.profile, glyph: UserRoundPlus }, { id: 'group', label: labels.newTitle.group, glyph: Users }]} onpick={id => oncreate(id as AgentEntryKind)}>
        <SquarePen size={16} strokeWidth={1.75} />
      </Menu>
    {/if}
  </header>

  {#if chats.length >= SEARCH_FROM || query}
    <label class="agents-search"><Search size={14} strokeWidth={1.75} /><input type="search" bind:value={query} aria-label={labels.search} placeholder={labels.search} /></label>
  {/if}

  <div class="agents-rail-list">
    {#each shown as chat (chatKey(chat.kind, chat.id))}
      {@const key = chatKey(chat.kind, chat.id)}
      <button type="button" class="ghost agents-row" class:active={active === key} aria-current={active === key ? 'page' : undefined} onclick={() => onfocus({ kind: chat.kind, id: chat.id })} data-testid="agent-entry-{chat.id}">
        <AgentAvatar kind={chat.kind} id={chat.id} name={chat.name} avatar={chat.avatar} members={memberList(chat)} status={chat.status} />
        <span class="agents-row-text">
          <span class="agents-row-line">
            <strong>{chat.name}</strong>
            <time datetime={new Date(chat.at).toISOString()}>{ago(chat.at, now)}</time>
          </span>
          <span class="agents-row-line">
            <small data-status={chat.status}>{preview(chat)}</small>
            {#if chat.attention}<span class="agent-count" data-tone="live" role="img" aria-label="{labels.attention}: {chat.attention}">{chat.attention}</span>
            {:else if chat.unread}<span class="agent-count" role="img" aria-label={fill(labels.unread, { count: String(chat.unread) })}>{chat.unread}</span>{/if}
          </span>
        </span>
      </button>
    {/each}
    {#each found as entry (`${entry.kind}:${entry.id}`)}
      <button type="button" class="ghost agents-row" onclick={() => onfocus({ kind: entry.kind, id: entry.id })} data-testid="agent-entry-{entry.id}">
        <AgentAvatar kind={entry.kind} id={entry.id} name={entry.name} avatar={entry.avatar} />
        <span class="agents-row-text"><strong>{entry.name}</strong><small>{entry.state}</small></span>
      </button>
    {/each}
    {#if needle && !shown.length && !found.length}<p class="agent-empty">{labels.noMatch}</p>{/if}
  </div>

  {#if counts.running || counts.pending || counts.paused || attention}
    <footer>
      {#if counts.running || counts.pending || counts.paused}
        <span class="agents-summary"><i data-status={counts.paused ? 'paused' : 'running'}></i>{counts.paused ? labels.paused : fill(labels.summary, { running: String(counts.running), pending: String(counts.pending) })}</span>
      {/if}
      {#if attention}
        <button type="button" class="ghost agents-attention" class:active={active === 'attention'} aria-current={active === 'attention' ? 'page' : undefined} onclick={() => onfocus({ kind: 'attention' })} data-testid="agents-attention">
          <Bell size={14} strokeWidth={1.75} />{labels.attention}<span class="agent-count" data-tone="live">{attention}</span>
        </button>
      {/if}
    </footer>
  {/if}
</aside>
