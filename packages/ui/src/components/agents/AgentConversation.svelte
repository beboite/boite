<script lang="ts">
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
  async function send() {
    const recipientIds = scope.kind === 'agent' ? [scope.id] : recipients;
    const signature = JSON.stringify(recipientIds);
    if (!request || request.text !== text || request.recipients !== signature) request = { text, recipients: signature, id: crypto.randomUUID() };
    const sent = await view.call('agents.message.send', { scope, text, recipientIds, requestId: request.id });
    if (sent) { text = ''; request = null; }
  }
</script>

<section class="agent-conversation" aria-label={strings.agents.conversation}>
  <div class="agent-transcript" data-testid="agent-transcript">
    {#each messages as message (message.id)}
      <article class="agent-message" class:from-user={message.senderId === null}>
        <header><span>{message.senderId === null ? strings.agents.user : view.snapshot?.profiles.find(a => a.id === message.senderId)?.name}</span><time datetime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></header>
        <div class="prose">{@html renderMarkdown(message.text)}</div>
        {#if message.recipientIds.length}<div class="agent-receipts">{#each view.snapshot?.deliveries.filter(d => d.messageId === message.id) ?? [] as delivery (delivery.id)}<span>{view.snapshot?.profiles.find(a => a.id === delivery.agentId)?.name} · {strings.agents[delivery.status]}</span>{/each}</div>{/if}
      </article>
    {:else}<p class="agent-empty">{strings.agents.noMessages}</p>{/each}
  </div>
  <form class="agents-form agent-composer" onsubmit={e => { e.preventDefault(); void send(); }}>
    {#if group}
      <fieldset><legend>{strings.agents.recipients}</legend><div class="agent-checks">{#each group.memberIds as id (id)}<label><input type="checkbox" checked={recipients.includes(id)} onchange={() => { recipients = recipients.includes(id) ? recipients.filter(r => r !== id) : [...recipients, id]; }} />{view.snapshot?.profiles.find(a => a.id === id)?.name}</label>{/each}</div></fieldset>
      <p class="muted">{strings.agents[group.mode]} · {group.maxTurns} {strings.agents.maxTurns.toLowerCase()}</p>
    {/if}
    <label class="agent-sr-only" for="agent-message-input">{strings.agents.message}</label>
    <textarea id="agent-message-input" required bind:value={text} rows="3" maxlength="32000" placeholder={strings.agents.message} data-testid="agent-message-input"></textarea>
    <button class="primary" disabled={view.pending || !text.trim()} data-testid="agent-message-send">{strings.agents.send}</button>
  </form>
</section>
