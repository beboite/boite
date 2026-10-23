<script lang="ts">
  import { errorText } from '../../lib/errors';
  import { secureId } from '../../lib/secure-id';
  import { onDestroy, tick, untrack } from 'svelte';
  import { ArrowDown, Brain, CalendarClock, CircleCheck, CircleQuestionMark, CircleStop, FileText, FolderKanban, Handshake, Image } from '@lucide/svelte';
  import type { AgentConversationMessage, AgentDelivery, AgentMessagesPage, AgentScope, AgentWork, Attachment, ImageMimeType, Message, MessagePart, ThreadSummary } from '@boite/contracts';
  import { chatKey, unreadMessages, type AgentsView } from '../../lib/agents.svelte';
  import { fill, strings } from '../../lib/strings';
  import { avatarStatus } from '../../lib/thread-state';
  import { bytes, longDay } from '../../lib/format';
  import type { ComposerTarget } from '../../lib/composer-target';
  import type { SentPrompt } from '../../lib/composer-queue';
  import Prose from '../Prose.svelte';
  import ChatFile from '../ChatFile.svelte';
  import Composer from '../Composer.svelte';
  import MessageActions from '../MessageActions.svelte';
  import UserMessage from '../UserMessage.svelte';
  import AgentAvatar from './AgentAvatar.svelte';
  import AgentWorkCard from './AgentWorkCard.svelte';
  import AgentPendingQuestions from './AgentPendingQuestions.svelte';

  /**
   * A conversation with an agent or a group, drawn the way a thread is: the
   * user's messages in bubbles on the right with the thread's receipts, the
   * agents' answers in the thread's answer bubbles under their picture and
   * name, a line while one of them works, and the thread's own composer at
   * the bottom (`lib/composer-target.ts`): attachments, dictation, recall,
   * Stop. Engine choices stay in Settings. An agent
   * shows no code: its answers carry the pictures and files it attached, and
   * its thread opens from the page's menu, not from here. Decisions
   * an agent asked for stand in the conversation they belong to. Opening it
   * starts at its first missed message and marks visible messages read.
   */
  let { view, scope, live = null }: {
    view: AgentsView;
    scope: AgentScope;
    /** The thread an agent of this conversation works in now. */
    live?: ThreadSummary | null;
  } = $props();
  let recipients = $state<string[]>([]);
  let request: { signature: string; id: string } | null = null;
  let scroller = $state<HTMLElement>();
  let disposed = false;
  onDestroy(() => { disposed = true; });
  const labels = $derived(strings.agents);
  const group = $derived(scope.kind === 'group' ? view.snapshot?.groups.find(g => g.id === scope.id) : null);
  const agent = $derived(scope.kind === 'agent' ? view.snapshot?.profiles.find(a => a.id === scope.id) ?? null : null);
  let page = $state<AgentMessagesPage | null>(null);
  let loading = $state(false);
  let followedSnapshot: number | undefined;
  const held = $derived(view.seen.messages.filter(m => m.scope.kind === scope.kind && m.scope.id === scope.id));
  const messages = $derived(page ? page.messages.map(m => held.find(h => h.id === m.id) ?? m) : held);
  const key = $derived(`message:${scope.kind}:${scope.id}`);
  const newest = $derived(messages.at(-1));
  const readKey = $derived(chatKey(scope.kind === 'agent' ? 'profile' : 'group', scope.id));
  let entry = $state<{ key: string; at: number; count: number | null; first: string | null } | null>(null);
  let ready = $state(false);
  let awayFromBottom = $state(false);
  // A latest window can show our sent message while earlier replies remain unread.
  let readGap = $state(false);
  const firstMissed = $derived(messages.find(m => m.id === entry?.first));
  const missedAtEntry = $derived(entry?.count ?? unreadMessages(view.snapshot, held, scope, entry?.at ?? 0));
  const unreadTotal = $derived(unreadMessages(view.snapshot, held, scope, view.readAt?.[readKey] ?? 0));
  const unread = $derived(messages.filter(m => m.senderId !== null && m.createdAt > (view.readAt?.[readKey] ?? 0)));
  const missedLabel = (count: number) => fill(count === 1 ? labels.missedOne : labels.missedMany, { count: String(count) });
  let divider = $state<HTMLElement>();
  /** Work of this conversation that waits on the user: a decision, an interruption, a failure. */
  const pending = $derived(view.snapshot?.work.filter(w => w.scope.kind === scope.kind && w.scope.id === scope.id && (['paused', 'waiting', 'interrupted', 'error'].includes(w.status) || view.seen.decisions.some(d => d.workId === w.id && d.status === 'pending'))) ?? []);
  const worker = $derived(live ? view.snapshot?.profiles.find(a => view.snapshot?.sessions.some(s => s.threadId === live.id && s.agentId === a.id)) ?? null : null);
  $effect.pre(() => {
    if (entry?.key === key) return;
    entry = { key, at: untrack(() => view.readAt?.[readKey] ?? 0), count: null, first: null };
    ready = false; page = null; loading = false; readGap = false; followedSnapshot = undefined;
  });
  // One indexed window starts at the first unread reply, even on a new device.
  $effect(() => {
    if (!ready && !loading && entry && scroller && view.snapshot) void untrack(() => loadMessages('open'));
  });
  // A bounded window that reached the end can pick up new replies. Older reading
  // windows wait for a scroll or the unread button, so no gap is ever skipped.
  $effect(() => {
    if (!ready || loading || !page || page.newer) return;
    if (view.snapshot?.revision === followedSnapshot) return;
    if (view.snapshot?.messages.some(m => m.scope.kind === scope.kind && m.scope.id === scope.id && (!newest || m.createdAt > newest.createdAt || m.createdAt === newest.createdAt && m.id > newest.id))) {
      followedSnapshot = view.snapshot.revision;
      void untrack(() => loadMessages('newer'));
    }
  });
  async function loadMessages(direction: 'open' | 'older' | 'newer' | 'latest' | 'unread') {
    if (loading || disposed || !scroller || !entry) return;
    const opening = key, box = scroller, height = box.scrollHeight, top = box.scrollTop;
    loading = true;
    if (direction === 'open') entry = { ...entry, count: unreadMessages(view.snapshot, held, scope, entry.at) };
    const edge = direction === 'older' ? messages[0] : direction === 'newer' ? newest : undefined;
    const cursor = edge ? { createdAt: edge.createdAt, id: edge.id } : undefined;
    const next = await view.readMessages({ scope, ...(direction === 'open' ? { readAt: entry.at } : direction === 'unread' ? { readAt: view.readAt?.[readKey] ?? 0 } : direction === 'older' ? { before: cursor } : direction === 'newer' ? { after: cursor } : {}) });
    if (disposed || opening !== key || box !== scroller) return;
    if (!next && direction !== 'open') { loading = false; return; }
    if (direction === 'open') entry = { ...entry, first: entry.count && next ? next.messages.find(m => m.senderId !== null && m.createdAt > entry!.at)?.id ?? null : null };
    if (next) {
      const startsAfterRead = next.older && !!next.messages[0] && next.messages[0].createdAt > (view.readAt?.[readKey] ?? 0);
      // Sending skips unseen replies even when the latest window overlaps this one.
      if (direction === 'latest') readGap = unreadTotal > 0 || startsAfterRead && (readGap || !next.messages.some(m => messages.some(previous => previous.id === m.id)));
      else if (direction === 'open' || direction === 'unread' || direction === 'older' && !startsAfterRead) readGap = false;
      const all = direction === 'older' ? [...next.messages, ...messages] : direction === 'newer' ? [...messages, ...next.messages] : next.messages;
      const unique = [...new Map(all.map(m => [m.id, m])).values()];
      // Adjacent history is appended without treating it as a newly arriving reply.
      const follow = direction === 'newer' && !page?.newer && !awayFromBottom;
      if (direction === 'older' || direction === 'unread' || direction === 'newer' && page?.newer) awayFromBottom = true;
      followed = unique.at(-1)?.id ?? '';
      page = { ...next, messages: unique, older: direction === 'newer' ? page?.older ?? next.older : next.older, newer: direction === 'older' ? page?.newer ?? next.newer : next.newer };
      if (follow) await tick().then(() => { if (!disposed && box === scroller) box.scrollTop = box.scrollHeight; });
    }
    await tick();
    if (disposed || opening !== key || box !== scroller) return;
    if (direction === 'open') {
      if (firstMissed && divider) box.scrollTop += divider.getBoundingClientRect().top - box.getBoundingClientRect().top;
      else box.scrollTop = box.scrollHeight;
    } else if (direction === 'unread') {
      const first = unread[0];
      const row = first ? [...box.querySelectorAll<HTMLElement>('[data-message-id]')].find(row => row.dataset.messageId === first.id) : null;
      if (row) box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top;
      else box.scrollTop = box.scrollHeight;
    } else if (direction === 'older') box.scrollTop = top + box.scrollHeight - height;
    else if (direction === 'latest') box.scrollTop = box.scrollHeight;
    followed = newest?.id ?? '';
    ready = true; loading = false;
    if (next || !page) readVisible();
  }
  /**
   * A user's own new message scrolls to the bottom. An agent's
   * message does only for a reader already there, measured before it is drawn;
   * someone reading older messages stays where they are.
   */
  const NEAR_BOTTOM = 80;
  let followed = '';
  $effect.pre(() => {
    if (!ready || !newest?.id || !scroller) return;
    const box = scroller;
    const follow = newest.senderId === null || box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM;
    if (followed === newest.id) return;
    followed = newest.id;
    if (follow) void tick().then(() => { if (!disposed && box === scroller && ready) { box.scrollTop = box.scrollHeight; readVisible(); } });
  });
  /** Reading elsewhere or in a hidden tab leaves incoming messages unread. */
  function readVisible() {
    if (disposed) return;
    const box = scroller;
    if (!ready || loading || !box || !box.clientHeight || document.hidden || !page && view.error) return;
    awayFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight >= NEAR_BOTTOM;
    if (readGap) return;
    const bounds = box.getBoundingClientRect();
    let at = view.readAt?.[readKey] ?? 0;
    for (const row of box.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const rect = row.getBoundingClientRect();
      if (rect.top < bounds.top + box.clientHeight && rect.bottom > bounds.top) at = Math.max(at, Number(row.dataset.messageAt));
    }
    if (at > 0) untrack(() => view.markRead(readKey, at));
    if (!awayFromBottom && page?.newer && !loading) void loadMessages('newer');
  }
  async function jumpToUnread() {
    const box = scroller;
    if (!box) return;
    if (readGap) { await loadMessages('unread'); return; }
    if (!unread.length && page?.newer) await loadMessages(unreadTotal ? 'newer' : 'latest');
    if (disposed) return;
    const first = unread[0];
    const row = first ? [...box.querySelectorAll<HTMLElement>('[data-message-id]')].find(row => row.dataset.messageId === first.id) : null;
    if (row) box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top;
    else box.scrollTop = box.scrollHeight;
    readVisible();
  }
  // Attached pictures and the composer can resize after the initial layout.
  $effect(() => {
    const box = scroller;
    const column = box?.firstElementChild;
    if (!box || !column) return;
    const observer = new ResizeObserver(() => {
      if (disposed || !untrack(() => ready)) return;
      if (!untrack(() => awayFromBottom)) box.scrollTop = box.scrollHeight;
      readVisible();
    });
    observer.observe(box); observer.observe(column);
    return () => observer.disconnect();
  });
  const profileOf = (id: string) => view.snapshot?.profiles.find(a => a.id === id);
  const nameOf = (id: string) => profileOf(id)?.name ?? id;
  /**
   * The routine a message reports on: a reply from a run no message of the
   * user started. Its name when that routine's last run is the one, an empty
   * string for an older run, null for any other message.
   */
  function plannedOf(message: AgentConversationMessage): string | null {
    if (message.replyTo !== null || scope.kind !== 'agent') return null;
    const work = workOf(message);
    if (!work || work.messageId !== null || work.taskId !== null || work.purpose === 'compaction' || work.purpose === 'notice') return null;
    return view.snapshot?.routines.find(r => r.lastWorkId === work.id)?.name ?? '';
  }
  /** The work an agent's message answers, through the run that wrote it. */
  function workOf(message: AgentConversationMessage): AgentWork | undefined {
    if (!message.sourceRunId) return undefined;
    const run = view.seen.runs.find(r => r.id === message.sourceRunId);
    return run ? view.seen.work.find(w => w.id === run.workId) : undefined;
  }
  /** The memory pass a reply shows: done or under way; nothing changed and failures stay quiet. */
  function memoryOf(work: AgentWork | undefined) {
    const pass = work?.memory;
    return pass && (pass.status === 'done' || pass.status === 'running') ? pass : null;
  }
  /** The reply whose memory summary a tap opened, for a phone that has no hover. */
  let memoryOpen = $state<string | null>(null);
  const placeholder = $derived(agent ? fill(labels.messageTo, { name: agent.name }) : group ? fill(labels.messageTo, { name: group.name }) : labels.message);
  /** The user's own messages here, newest first: what ArrowUp brings back. */
  const sent = $derived<SentPrompt[]>(messages.filter(m => m.senderId === null && m.text).map(m => ({ id: m.id, text: m.text, attachments: [], previewReferences: [] })).reverse());
  /** A direct conversation's agent answers on its own account's provider, which decides what goes as an image. */
  const provider = $derived.by(() => {
    const account = agent ? view.store.accountOf(agent.selection.accountId) : null;
    return account ? view.store.providerOf(account.providerId) ?? null : null;
  });
  /** The work of this conversation under way now: what Stop cancels. */
  const running = $derived(view.snapshot?.work.find(w => w.scope.kind === scope.kind && w.scope.id === scope.id && w.status === 'running') ?? null);
  const target = $derived<ComposerTarget>({
    key: `agent:${scope.kind}:${scope.id}`,
    placeholder,
    provider,
    sent,
    busy: !!running,
    send,
    stop: running ? () => void stopWork() : undefined,
    chips: group ? recipientChips : undefined,
  });

  async function send(text: string, attachments: Attachment[]): Promise<boolean> {
    const recipientIds = scope.kind === 'agent' ? [scope.id] : recipients;
    // The same message sent again after a lost answer keeps its request id, so the core takes it once; other bytes are another message.
    const signature = JSON.stringify([text, recipientIds, attachments.map(a => [a.kind, a.name, contentHash(a.data)])]);
    try {
      if (!request || request.signature !== signature) request = { signature, id: secureId() };
      const sent = await view.call('agents.message.send', { scope, text, recipientIds, requestId: request.id, ...(attachments.length ? { attachments } : {}) });
      if (sent) { request = null; await loadMessages('latest'); return true; }
    } catch (error) { view.error = errorText(error); }
    return false;
  }
  /** FNV-1a over the base64 text: enough to tell a replaced file from a retried one. */
  function contentHash(data: string): string {
    let hash = 0x811c9dc5;
    for (let at = 0; at < data.length; at++) hash = Math.imul(hash ^ data.charCodeAt(at), 0x01000193);
    return `${data.length}:${(hash >>> 0).toString(36)}`;
  }
  async function stopWork() {
    const work = running;
    if (work) await view.call('agents.work.control', { workId: work.id, expectedRevision: work.revision, action: 'cancel' });
  }
  /**
   * The user's message as a thread's prompt, for the thread's own bubble:
   * its words, then what it was sent with where the agent's turn keeps the
   * bytes, at the same places as in that turn's prompt. Until a turn took
   * them it is only the words.
   */
  function promptOf(message: AgentConversationMessage): Message {
    const words: MessagePart = { type: 'text', text: message.text };
    const attachments = message.attachments ?? [];
    const source = attachments[0]?.source;
    const placed = source ? attachments.map((a, at) => a.source?.threadId === source.threadId && a.source.messageId === source.messageId && a.source.partIndex === at + 1) : [];
    if (!source || !placed.every(Boolean)) return { id: message.id, threadId: '', turnId: '', role: 'user', state: 'complete', createdAt: message.createdAt, parts: [words] };
    const parts = attachments.map((a): MessagePart => a.kind === 'image'
      ? { type: 'image', mimeType: a.mimeType as ImageMimeType, data: '', alt: a.name, dataDeferred: true, bytes: a.bytes }
      : { type: 'file', mimeType: a.mimeType, data: '', name: a.name, dataDeferred: true, bytes: a.bytes });
    return { id: source.messageId, threadId: source.threadId, turnId: '', role: 'user', state: 'complete', createdAt: message.createdAt, parts: [words, ...parts] };
  }
  /** A user message's two ticks: the core holds it, and an agent took it into a turn. */
  function receipts(message: AgentConversationMessage) {
    const deliveries = view.seen.deliveries.filter(d => d.messageId === message.id);
    return { responded: deliveries.some(received) || messages.some(m => m.replyTo === message.id) || held.some(m => m.replyTo === message.id) };
  }
  /** Older cores marked received messages failed when their execution stopped. */
  function received(delivery: AgentDelivery): boolean {
    return delivery.status === 'included' || delivery.status === 'processed'
      || view.seen.runs.some(run => run.workId === delivery.workId && run.startedAt !== null)
      || messages.some(m => m.replyTo === delivery.messageId && m.senderId === delivery.agentId)
      || held.some(m => m.replyTo === delivery.messageId && m.senderId === delivery.agentId);
  }
</script>

<svelte:document onvisibilitychange={readVisible} />

{#snippet recipientChips()}
  {#if group}
    <div class="agent-recipients" role="group" aria-label={labels.recipients}>
      <button type="button" class="chip" class:on={!recipients.length} aria-pressed={!recipients.length} onclick={() => { recipients = []; }}>{labels.toEveryone}</button>
      {#each group.memberIds as id (id)}
        {@const member = profileOf(id)}
        <button type="button" class="chip" class:on={recipients.includes(id)} aria-pressed={recipients.includes(id)} onclick={() => { recipients = recipients.includes(id) ? recipients.filter(r => r !== id) : [...recipients, id]; }}>
          <AgentAvatar kind="profile" {id} name={member?.name ?? id} avatar={member?.avatar} size={16} />{nameOf(id)}
        </button>
      {/each}
    </div>
  {/if}
{/snippet}

<section class="agent-chat" aria-label={labels.conversation}>
  <div class="agent-chat-scroll" bind:this={scroller} onscroll={readVisible}>
    <div class="agent-chat-column" data-testid="agent-transcript">
      {#if !ready}<p class="agent-reading-status" role="status">{labels.loadingMissed}</p>{/if}
      {#if page?.older || !page && view.hasOlder(key, 'message')}<button type="button" class="ghost small agent-older" disabled={loading} onclick={() => void loadMessages(page ? 'older' : 'open')} data-testid="agent-messages-older">{labels.loadEarlier}</button>{/if}
      {#each messages as message, index (message.id)}
        {@const previous = messages[index - 1]}
        {@const mine = message.senderId === null}
        {@const newDay = !previous || longDay(previous.createdAt) !== longDay(message.createdAt)}
        {@const first = newDay || previous.senderId !== message.senderId || message.id === firstMissed?.id}
        {#if newDay}<p class="agent-day"><span>{longDay(message.createdAt)}</span></p>{/if}
        {#if message.id === firstMissed?.id}<p class="agent-unread-divider" bind:this={divider} data-testid="agent-unread-divider"><span>{missedLabel(missedAtEntry)}</span></p>{/if}
        {#if mine}
          {@const failed = view.seen.deliveries.filter(d => d.messageId === message.id && (d.status === 'failed' || d.status === 'limited') && !received(d))}
          {@const prompt = promptOf(message)}
          <article class="agent-message message from-user" class:first data-message-id={message.id} data-message-at={message.createdAt} data-testid="agent-user-message">
            <span class="agent-sr-only">{labels.user}</span>
            <UserMessage store={view.store} message={prompt} turn={undefined} accepted={true} responded={receipts(message).responded} />
            {#if prompt.parts.length === 1 && message.attachments?.length}
              <!-- No turn took them yet: their name and size until the agent's thread holds the bytes. -->
              <div class="agent-attachments">
                {#each message.attachments as attachment, at (at)}
                  <span class="agent-attachment" data-testid="agent-attachment">
                    {#if attachment.kind === 'image'}<Image size={18} strokeWidth={1.5} />{:else}<FileText size={18} strokeWidth={1.5} />{/if}
                    <span><span>{attachment.name ?? strings.composer.attachAlt}</span><small>{bytes(attachment.bytes)}</small></span>
                  </span>
                {/each}
              </div>
            {/if}
            {#each failed as delivery (delivery.id)}<p class="failed">{fill(labels.deliveryFailed, { name: nameOf(delivery.agentId) })}</p>{/each}
          </article>
        {:else if message.thread?.event === 'entrusted'}
          <!-- Taking a thread over is a moment of the conversation, marked across it the way a started thread is. -->
          {@const event = message.thread}
          {@const present = view.store.threads.some(t => t.id === event.id)}
          <div class="agent-marker" data-message-id={message.id} data-message-at={message.createdAt} data-testid="agent-thread-event" data-event="entrusted">
            <span class="rule"></span>
            {#if present}
              <button type="button" class="ghost small label" title={labels.openThread} onclick={() => void view.store.open(event.id)} data-testid="agent-thread-event-open"><Handshake size={13} strokeWidth={1.75} /><span class="ui-label">{fill(labels.threadEvent.entrusted, { name: nameOf(message.senderId!), title: event.title })}</span></button>
            {:else}
              <span class="label"><Handshake size={13} strokeWidth={1.75} /><span class="ui-label">{fill(labels.threadEvent.entrusted, { name: nameOf(message.senderId!), title: event.title })}</span></span>
            {/if}
            <span class="rule"></span>
          </div>
        {:else}
          {@const sender = profileOf(message.senderId!)}
          {@const planned = plannedOf(message)}
          {@const event = message.thread}
          {@const work = workOf(message)}
          {@const memory = memoryOf(work)}
          <article class="agent-message message from-agent" class:first class:labelled={!!event || work?.purpose === 'notice' || planned !== null} data-message-id={message.id} data-message-at={message.createdAt} data-event={event?.event} data-testid={event ? 'agent-thread-event' : undefined}>
            {#if group && first}
              <header>
                <AgentAvatar kind="profile" id={message.senderId!} name={sender?.name ?? ''} avatar={sender?.avatar} size={20} />
                <strong>{nameOf(message.senderId!)}</strong>
              </header>
            {:else}<span class="agent-sr-only">{nameOf(message.senderId!)}</span>{/if}
            {#if event}
              <!-- How an entrusted thread ended: a label over the agent's bubble, like a planned task's, that opens the thread. -->
              <button type="button" class="ghost small event-label" data-event={event.event} title={labels.openThread} disabled={!view.store.threads.some(t => t.id === event.id)} onclick={() => void view.store.open(event.id)} data-testid="agent-thread-event-open">
                {#if event.event === 'done'}<CircleCheck size={13} strokeWidth={1.75} />{:else if event.event === 'blocked'}<CircleQuestionMark size={13} strokeWidth={1.75} />{:else}<CircleStop size={13} strokeWidth={1.75} />{/if}
                <span class="ui-label">{fill(labels.threadEvent[event.event], { name: nameOf(message.senderId!), title: event.title })}</span>
              </button>
            {:else if work?.purpose === 'notice'}<p class="planned-label" data-testid="agent-notice"><FolderKanban size={13} strokeWidth={1.75} /><span>{labels.aboutProjects}</span></p>
            {:else if planned !== null}<p class="planned-label" data-testid="agent-planned-result"><CalendarClock size={13} strokeWidth={1.75} /><span>{planned || labels.plannedResult}</span></p>{/if}
            {#if message.text.trim()}<div class="answer"><Prose text={message.text} store={view.store} bubble /></div>{/if}
            {#if message.files?.length}
              <div class="agent-files" data-testid="agent-files">
                {#each message.files as file (`${file.threadId}:${file.messageId}:${file.part.id}`)}<ChatFile file={file.part} store={view.store} threadId={file.threadId} messageId={file.messageId} />{/each}
              </div>
            {/if}
            {#if memory}
              {@const summary = memory.status === 'done' ? memory.summary ?? '' : ''}
              <div class="agent-memory-pass" data-status={memory.status} data-testid="agent-memory">
                <button type="button" class="ghost small memory-chip" title={summary || undefined} aria-expanded={summary ? memoryOpen === message.id : undefined} disabled={!summary} onclick={() => { memoryOpen = memoryOpen === message.id ? null : message.id; }}>
                  <Brain size={12} strokeWidth={1.75} /><span class="ui-label">{memory.status === 'done' ? labels.memoryUpdated : labels.memoryUpdating}</span>
                </button>
                {#if summary && memoryOpen === message.id}<p class="memory-summary" data-testid="agent-memory-summary">{summary}</p>{/if}
              </div>
            {/if}
            <footer><MessageActions text={message.text} at={message.createdAt} /></footer>
          </article>
        {/if}
      {:else}
        <div class="agent-chat-empty">
          {#if agent}<AgentAvatar kind="profile" id={agent.id} name={agent.name} avatar={agent.avatar} size={72} />{/if}
          <p>{agent ? fill(labels.sayHello, { name: agent.name }) : labels.noMessagesYet}</p>
        </div>
      {/each}

      {#if page?.newer}<button type="button" class="ghost small agent-older" disabled={loading} onclick={() => void loadMessages('newer')} data-testid="agent-messages-newer">{labels.loadLater}</button>{/if}
      {#each pending as work (work.id)}<AgentWorkCard {view} {work} compact />{/each}
      <AgentPendingQuestions {view} {scope} />

      {#if live}
        <!-- What a messenger shows while the other side types: the agent at work. -->
        <div class="agent-typing" data-status={live.status} data-testid="agent-live">
          <AgentAvatar kind="profile" id={worker?.id ?? ''} name={worker?.name ?? ''} avatar={worker?.avatar} status={avatarStatus(live.status)} size={22} />
          <div class="typing-bubble">
            {#if live.status === 'waiting'}<span>{fill(labels.liveWaiting, { name: worker?.name ?? '' })}</span>
            {:else}<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="typing-text">{fill(labels.liveWorking, { name: worker?.name ?? '' })}</span>{/if}
          </div>
        </div>
      {/if}
    </div>
  </div>

  {#if ready && (awayFromBottom || readGap)}
    <div class="agent-jump"><button type="button" class="chip" disabled={loading} onclick={jumpToUnread} data-testid="agent-jump-unread"><ArrowDown size={14} /><span>{unreadTotal ? missedLabel(unreadTotal) : labels.latestMessages}</span></button></div>
  {/if}

  <Composer store={view.store} {target} />
</section>
