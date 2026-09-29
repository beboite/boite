<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { ArrowUp } from '@lucide/svelte';
  import type { AgentScope } from '@boite/contracts';
  import { chatKey, tintOf, type AgentsView } from '../../lib/agents.svelte';
  import { strings } from '../../lib/strings';
  import { formatLocale } from '../../lib/i18n.svelte';
  import { renderMarkdown } from '../../lib/markdown';

  /**
   * A messenger conversation: the user's messages on the right, the agents' on
   * the left, the sender's name over the first of a run in a group, a day line
   * between days. Opening it marks it read up to its newest message.
   */
  let { view, scope }: { view: AgentsView; scope: AgentScope } = $props();
  let text = $state('');
  let recipients = $state<string[]>([]);
  let request: { text: string; recipients: string; id: string } | null = null;
  let section = $state<HTMLElement>();
  let group = $derived(scope.kind === 'group' ? view.snapshot?.groups.find(g => g.id === scope.id) : null);
  let messages = $derived(view.seen.messages.filter(m => m.scope.kind === scope.kind && m.scope.id === scope.id));
  const key = $derived(`message:${scope.kind}:${scope.id}`);
  const history = $derived({ kind: 'message' as const, scopes: [scope] });
  const newest = $derived(messages.at(-1));
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
    if (!newest?.id || !section) return;
    const box = section.parentElement;
    if (!box) return;
    const follow = followed !== key || newest.senderId === null || box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM;
    followed = key;
    if (follow) void tick().then(() => { box.scrollTop = box.scrollHeight; });
  });
  const nameOf = (id: string) => view.snapshot?.profiles.find(a => a.id === id)?.name ?? id;
  const time = (at: number) => new Date(at).toLocaleTimeString(formatLocale(), { hour: '2-digit', minute: '2-digit' });
  const day = (at: number) => new Date(at).toLocaleDateString(formatLocale(), { weekday: 'long', day: 'numeric', month: 'long' });

  async function send() {
    if (!text.trim() || view.pending) return;
    const recipientIds = scope.kind === 'agent' ? [scope.id] : recipients;
    const signature = JSON.stringify(recipientIds);
    if (!request || request.text !== text || request.recipients !== signature) request = { text, recipients: signature, id: crypto.randomUUID() };
    const sent = await view.call('agents.message.send', { scope, text, recipientIds, requestId: request.id });
    if (sent) { text = ''; request = null; }
  }
  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void send();
  }
</script>

<section class="agent-conversation" aria-label={strings.agents.conversation} bind:this={section}>
  <div class="agent-transcript" data-testid="agent-transcript">
    {#if view.hasOlder(key, 'message')}<button type="button" class="ghost small agent-older" disabled={view.loadingOlder === key} onclick={() => void view.loadOlder(key, history, messages)} data-testid="agent-messages-older">{strings.agents.loadEarlier}</button>{/if}
    {#each messages as message, index (message.id)}
      {@const previous = messages[index - 1]}
      {@const mine = message.senderId === null}
      {@const first = !previous || previous.senderId !== message.senderId || day(previous.createdAt) !== day(message.createdAt)}
      {#if !previous || day(previous.createdAt) !== day(message.createdAt)}<p class="agent-day"><span>{day(message.createdAt)}</span></p>{/if}
      <article class="agent-message" class:from-user={mine} class:first>
        {#if mine}<span class="agent-sr-only">{strings.agents.user}</span>
        {:else if group && first}<header style:--tint={tintOf(message.senderId!)}>{nameOf(message.senderId!)}</header>
        {:else}<span class="agent-sr-only">{nameOf(message.senderId!)}</span>{/if}
        <div class="prose">{@html renderMarkdown(message.text)}</div>
        <time datetime={new Date(message.createdAt).toISOString()}>{time(message.createdAt)}</time>
        {#if group && message.recipientIds.length}<div class="agent-receipts">{#each view.seen.deliveries.filter(d => d.messageId === message.id) as delivery (delivery.id)}<span>{nameOf(delivery.agentId)} · {strings.agents[delivery.status]}</span>{/each}</div>{/if}
      </article>
    {:else}<p class="agent-empty agent-chat-empty">{strings.agents.noMessagesYet}</p>{/each}
  </div>
  <form class="agent-composer" onsubmit={e => { e.preventDefault(); void send(); }}>
    {#if group}
      <div class="agent-recipients" role="group" aria-label={strings.agents.recipients}>
        <button type="button" class="chip" class:on={!recipients.length} aria-pressed={!recipients.length} onclick={() => { recipients = []; }}>{strings.agents.toEveryone}</button>
        {#each group.memberIds as id (id)}
          <button type="button" class="chip" class:on={recipients.includes(id)} aria-pressed={recipients.includes(id)} onclick={() => { recipients = recipients.includes(id) ? recipients.filter(r => r !== id) : [...recipients, id]; }}>{nameOf(id)}</button>
        {/each}
      </div>
    {/if}
    <div class="agent-composer-row">
      <label class="agent-sr-only" for="agent-message-input">{strings.agents.message}</label>
      <textarea id="agent-message-input" required bind:value={text} rows="1" maxlength="32000" placeholder={strings.agents.message} {onkeydown} data-testid="agent-message-input"></textarea>
      <button class="primary icon" aria-label={strings.agents.send} title={strings.agents.send} disabled={view.pending || !text.trim()} data-testid="agent-message-send"><ArrowUp size={16} /></button>
    </div>
  </form>
</section>
