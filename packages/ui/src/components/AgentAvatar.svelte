<script lang="ts">
  import { Bot } from '@lucide/svelte';
  import type { AgentProfile, ThreadStatus } from '@boite/contracts';
  import ProviderLogo from './ProviderLogo.svelte';
  import StatusMark from './StatusMark.svelte';
  import ProfileAvatar from './agents/AgentAvatar.svelte';
  import { threadTone } from '../lib/thread-state';

  /**
   * The other end of a discussion: its provider's mark, or for the persistent
   * agent that looks after this thread's project its robot, else a robot
   * glyph in that agent's colour, with its live state in the corner once it
   * works or failed. An idle agent has no dot: most discussions are with
   * agents that finished.
   */
  let { title, providerId, status, resident = false, agent, size = 30 }: {
    title: string; providerId?: string; status?: ThreadStatus; resident?: boolean;
    agent?: Pick<AgentProfile, 'id' | 'name' | 'avatar'>; size?: number;
  } = $props();
  let initial = $derived((title.trim()[0] ?? '?').toUpperCase());
</script>

{#if resident && agent}
  <span class="robot" data-testid="resident-avatar" data-agent-id={agent.id}>
    <ProfileAvatar kind="profile" id={agent.id} name={agent.name} avatar={agent.avatar} status={status ?? 'idle'} {size} />
  </span>
{:else}
  <span class="avatar" class:resident style:--size="{size}px" aria-hidden="true">
    {#if resident}<Bot size={Math.round(size * 0.55)} strokeWidth={1.75} />
    {:else if providerId}<ProviderLogo {providerId} size={Math.round(size * 0.55)} />
    {:else}<span class="initial">{initial}</span>{/if}
    {#if status && status !== 'idle'}<StatusMark {...threadTone(status)} corner />{/if}
  </span>
{/if}

<style>
  .robot { flex: none; display: inline-flex; }
  .avatar { --ring: var(--color-background); position: relative; flex: none; width: var(--size); height: var(--size); display: grid; place-items: center; border-radius: var(--radius-md); border: 1px solid var(--color-border); background: var(--color-surface-3); color: var(--color-muted-foreground); }
  .avatar.resident { border-color: color-mix(in oklch, var(--color-resident) 45%, transparent); background: var(--color-resident-soft); color: var(--color-resident); }
  .initial { font-size: calc(var(--size) * 0.42); font-weight: 600; line-height: 1; color: var(--color-foreground); }
</style>
