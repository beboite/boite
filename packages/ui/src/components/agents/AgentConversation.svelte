<script lang="ts">
  import { secureId } from '../../lib/secure-id';
  import { tick, untrack } from 'svelte';
  import { ArrowUp, CalendarClock, CircleCheck, CircleQuestionMark, CircleStop, Handshake, SquareArrowOutUpRight } from '@lucide/svelte';
  import type { AgentConversationMessage, AgentScope, ThreadSummary } from '@boite/contracts';
  import { chatKey, type AgentsView } from '../../lib/agents.svelte';
  import { fill, strings } from '../../lib/strings';
  import { formatLocale } from '../../lib/i18n.svelte';
  import Prose from '../Prose.svelte';
  import AgentAvatar from './AgentAvatar.svelte';
  import AgentWorkCard from './AgentWorkCard.svelte';

  /**
   * A conversation with an agent or a group, drawn the way a thread is: the
   * user's messages in bubbles on the right, the agents' answers in the
   * thread's answer bubbles under their picture and name, a line while one of them works with the way into
   * the thread it works in, and the thread's composer at the bottom. Decisions
   * an agent asked for stand in the conversation they belong to. Opening it
   * marks it read up to its newest message.
   */
  let { view, scope, live = null, onschedule }: {
    view: AgentsView;
    scope: AgentScope;
    /** The thread an agent of this conversation works in now. */
    live?: ThreadSummary | null;
    /** Turns what is written into a routine; only a direct conversation has one. */
    onschedule?: (text: string) => void;
  } = $props();
  let text = $state('');
  let recipients = $state<string[]>([]);
  let request: { text: string; recipients: string; id: string } | null = null;
  let scroller = $state<HTMLElement>();
  let box = $state<HTMLTextAreaElement>();
  const labels = $derived(strings.agents);
  const group = $derived(scope.kind === 'group' ? view.snapshot?.groups.find(g => g.id === scope.id) : null);
  const agent = $derived(scope.kind === 'agent' ? view.snapshot?.profiles.find(a => a.id === scope.id) ?? null : null);
  const messages = $derived(view.seen.messages.filter(m => m.scope.kind === scope.kind && m.scope.id === scope.id));
  const key = $derived(`message:${scope.kind}:${scope.id}`);
  const history = $derived({ kind: 'message' as const, scopes: [scope] });
  const newest = $derived(messages.at(-1));
  /** Work of this conversation that waits on the user: a decision, an interruption, a failure. */
  const pending = $derived(view.snapshot?.work.filter(w => w.scope.kind === scope.kind && w.scope.id === scope.id && (['waiting', 'interrupted', 'error'].includes(w.status) || view.seen.decisions.some(d => d.workId === w.id && d.status === 'pending'))) ?? []);
  const worker = $derived(live ? view.snapshot?.profiles.find(a => view.snapshot?.sessions.some(s => s.threadId === live.id && s.agentId === a.id)) ?? null : null);
  $effect(() => { view.fill(key, history, messages); });
  $effect(() => {
    const at = newest?.createdAt;
    if (at) untrack(() => view.markRead(chatKey(scope.kind === 'agent' ? 'profile' : 'group', scope.id), at));
  });
  /**
   * The first render and the user's own message scroll to the bottom. An agent's
   * message does only for a reader already there, measured before it is drawn;
   * someone reading older messages stays where they are.
   */
  const NEAR_BOTTOM = 80;
  let followed = '';
  $effect.pre(() => {
    if (!newest?.id || !scroller) return;
    const box = scroller;
    const follow = followed !== key || newest.senderId === null || box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM;
    followed = key;
    if (follow) void tick().then(() => { box.scrollTop = box.scrollHeight; });
  });
  const profileOf = (id: string) => view.snapshot?.profiles.find(a => a.id === id);
  const nameOf = (id: string) => profileOf(id)?.name ?? id;
  /**
   * The routine a message reports on: a reply from a run no message of the
   * user started. Its name when that routine's last run is the one, an empty
   * string for an older run, null for any other message.
   */
  function plannedOf(message: AgentConversationMessage): string | null {
    if (message.replyTo !== null || message.sourceRunId === null || scope.kind !== 'agent') return null;
    const run = view.seen.runs.find(r => r.id === message.sourceRunId);
    const work = run ? view.seen.work.find(w => w.id === run.workId) : undefined;
    if (!work || work.messageId !== null || work.taskId !== null || work.purpose === 'compaction') return null;
    return view.snapshot?.routines.find(r => r.lastWorkId === work.id)?.name ?? '';
  }
  const time = (at: number) => new Date(at).toLocaleTimeString(formatLocale(), { hour: '2-digit', minute: '2-digit' });
  const day = (at: number) => new Date(at).toLocaleDateString(formatLocale(), { weekday: 'long', day: 'numeric', month: 'long' });
  const placeholder = $derived(agent ? fill(labels.messageTo, { name: agent.name }) : group ? fill(labels.messageTo, { name: group.name }) : labels.message);

  async function send() {
    if (!text.trim() || view.pending) return;
    const recipientIds = scope.kind === 'agent' ? [scope.id] : recipients;
    const signature = JSON.stringify(recipientIds);
    try {
      if (!request || request.text !== text || request.recipients !== signature) request = { text, recipients: signature, id: secureId() };
      const sent = await view.call('agents.message.send', { scope, text, recipientIds, requestId: request.id });
      if (sent) { text = ''; request = null; }
    } catch (error) { view.error = error instanceof Error ? error.message : String(error); }
  }
  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void send();
  }
</script>

<section class="agent-chat" aria-label={labels.conversation}>
  <div class="agent-chat-scroll" bind:this={scroller}>
    <div class="agent-chat-column" data-testid="agent-transcript">
      {#if view.hasOlder(key, 'message')}<button type="button" class="ghost small agent-older" disabled={view.loadingOlder === key} onclick={() => void view.loadOlder(key, history, messages)} data-testid="agent-messages-older">{labels.loadEarlier}</button>{/if}
      {#each messages as message, index (message.id)}
        {@const previous = messages[index - 1]}
        {@const next = messages[index + 1]}
        {@const mine = message.senderId === null}
        {@const newDay = !previous || day(previous.createdAt) !== day(message.createdAt)}
        {@const first = newDay || previous.senderId !== message.senderId}
        {@const lastOfRun = !next || next.senderId !== message.senderId || day(next.createdAt) !== day(message.createdAt)}
        {#if newDay}<p class="agent-day"><span>{day(message.createdAt)}</span></p>{/if}
        {#if mine}
          {@const failed = view.seen.deliveries.filter(d => d.messageId === message.id && (d.status === 'failed' || d.status === 'limited'))}
          <article class="agent-message from-user" class:first>
            <span class="agent-sr-only">{labels.user}</span>
            <div class="bubble"><p class="user-text">{message.text}</p></div>
            {#if lastOfRun || failed.length}
              <footer>
                {#if lastOfRun}<time datetime={new Date(message.createdAt).toISOString()}>{time(message.createdAt)}</time>{/if}
                {#each failed as delivery (delivery.id)}<span class="failed">{fill(labels.deliveryFailed, { name: nameOf(delivery.agentId) })}</span>{/each}
              </footer>
            {/if}
          </article>
        {:else if message.thread?.event === 'entrusted'}
          <!-- Taking a thread over is a moment of the conversation, marked across it the way a started thread is. -->
          {@const event = message.thread}
          {@const present = view.store.threads.some(t => t.id === event.id)}
          <div class="agent-marker" data-testid="agent-thread-event" data-event="entrusted">
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
          <article class="agent-message from-agent" class:first data-event={event?.event} data-testid={event ? 'agent-thread-event' : undefined}>
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
            {:else if planned !== null}<p class="planned-label" data-testid="agent-planned-result"><CalendarClock size={13} strokeWidth={1.75} /><span>{planned || labels.plannedResult}</span></p>{/if}
            {#if message.text.trim()}<div class="answer"><Prose text={message.text} store={view.store} bubble /></div>{/if}
            {#if lastOfRun}<footer><time datetime={new Date(message.createdAt).toISOString()}>{time(message.createdAt)}</time></footer>{/if}
          </article>
        {/if}
      {:else}
        <div class="agent-chat-empty">
          {#if agent}<AgentAvatar kind="profile" id={agent.id} name={agent.name} avatar={agent.avatar} size={72} />{/if}
          <p>{agent ? fill(labels.sayHello, { name: agent.name }) : labels.noMessagesYet}</p>
        </div>
      {/each}

      {#each pending as work (work.id)}<AgentWorkCard {view} {work} compact />{/each}

      {#if live}
        <!-- What a messenger shows while the other side types: the agent at work, with the way into its thread. -->
        <div class="agent-typing" data-status={live.status} data-testid="agent-live">
          <AgentAvatar kind="profile" id={worker?.id ?? ''} name={worker?.name ?? ''} avatar={worker?.avatar} status={live.status === 'waiting' ? 'waiting' : 'running'} size={22} />
          <div class="typing-bubble">
            {#if live.status === 'waiting'}<span>{fill(labels.liveWaiting, { name: worker?.name ?? '' })}</span>
            {:else}<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="typing-text">{fill(labels.liveWorking, { name: worker?.name ?? '' })}</span>{/if}
          </div>
          <button type="button" class="ghost icon small" title={labels.seeThread} aria-label={labels.seeThread} onclick={() => void view.store.open(live.id)} data-testid="agent-live-open"><SquareArrowOutUpRight size={14} strokeWidth={1.75} /></button>
        </div>
      {/if}
    </div>
  </div>

  <form class="agent-composer-wrap" onsubmit={e => { e.preventDefault(); void send(); }}>
    <div class="agent-composer">
      <label class="agent-sr-only" for="agent-message-input">{placeholder}</label>
      <textarea id="agent-message-input" bind:this={box} bind:value={text} rows="1" maxlength="32000" {placeholder} {onkeydown} data-testid="agent-message-input"></textarea>
      <div class="agent-composer-bar">
        <div class="agent-composer-chips">
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
          {:else if onschedule && view.store.owner}
            <button type="button" class="chip ghost-chip" title={labels.when.scheduleThis} onclick={() => { onschedule(text); text = ''; }} data-testid="agent-schedule-message"><CalendarClock size={14} strokeWidth={1.75} />{labels.when.scheduleShort}</button>
          {/if}
        </div>
        <button class="primary icon send" aria-label={labels.send} title={labels.send} disabled={view.pending || !text.trim()} data-testid="agent-message-send"><ArrowUp size={16} strokeWidth={2.25} /></button>
      </div>
    </div>
  </form>
</section>
