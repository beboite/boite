<script lang="ts">
  import { ArrowUp } from '@lucide/svelte';
  import type { AgentScope } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { strings } from '../../lib/strings';
  import { renderMarkdown } from '../../lib/markdown';
  let { view, scope }: { view: AgentsView; scope: AgentScope } = $props();
  let text = $state('');
  let recipients = $state<string[]>([]);
  let request: { text: string; recipients: string; id: string } | null = null;
  let group = $derived(scope.kind === 'group' ? view.snapshot?.groups.find(g => g.id === scope.id) : null);
  let messages = $derived(view.snapshot?.messages.filter(m => m.scope.kind === scope.kind && m.scope.id === scope.id) ?? []);
  const nameOf = (id: string) => view.snapshot?.profiles.find(a => a.id === id)?.name ?? id;

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

<section class="agent-conversation" aria-label={strings.agents.conversation}>
  <div class="agent-transcript" data-testid="agent-transcript">
    {#each messages as message (message.id)}
      <article class="agent-message" class:from-user={message.senderId === null}>
        <header><span>{message.senderId === null ? strings.agents.user : nameOf(message.senderId)}</span><time datetime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></header>
        <div class="prose">{@html renderMarkdown(message.text)}</div>
        {#if group && message.recipientIds.length}<div class="agent-receipts">{#each view.snapshot?.deliveries.filter(d => d.messageId === message.id) ?? [] as delivery (delivery.id)}<span>{nameOf(delivery.agentId)} · {strings.agents[delivery.status]}</span>{/each}</div>{/if}
      </article>
    {:else}<p class="agent-empty">{strings.agents.noMessages}</p>{/each}
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
    <label class="agent-sr-only" for="agent-message-input">{strings.agents.message}</label>
    <textarea id="agent-message-input" required bind:value={text} rows="2" maxlength="32000" placeholder={strings.agents.message} {onkeydown} data-testid="agent-message-input"></textarea>
    <div class="agent-composer-foot">
      <span class="muted">{group ? `${strings.agents[group.mode]} · ${group.maxTurns} ${strings.agents.maxTurns.toLowerCase()}` : strings.agents.sendHint}</span>
      <button class="primary icon" aria-label={strings.agents.send} title={strings.agents.send} disabled={view.pending || !text.trim()} data-testid="agent-message-send"><ArrowUp size={16} /></button>
    </div>
  </form>
</section>
