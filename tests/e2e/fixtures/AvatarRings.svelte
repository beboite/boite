<script lang="ts">
  import '../../../packages/ui/src/app.css';
  import AgentAvatar from '../../../packages/ui/src/components/agents/AgentAvatar.svelte';
  import AgentRow from '../../../packages/ui/src/components/agents/AgentRow.svelte';

  const bots = [
    { name: 'Orbit', avatar: 'bot:b.0.1.0.0', status: 'running' },
    { name: 'Scout', avatar: 'bot:d.0.3.0.0', status: 'waiting' },
    { name: 'Beacon', avatar: 'bot:a.0.0.0.0', status: 'idle' },
    { name: 'Relay', avatar: 'bot:c.0.2.0.0', status: 'running' },
    { name: 'Helper', avatar: 'H', status: 'idle' },
  ];
</script>

<section class="agents-rail">
  <h1>Bots</h1>
  {#each bots as bot}
    <AgentRow title={bot.name} at={0} now={0} detail={bot.status === 'running' ? 'Working' : bot.status === 'waiting' ? 'Waiting for you' : 'Ready'} onclick={() => {}}>
      {#snippet picture()}<AgentAvatar kind="profile" id={bot.name} name={bot.name} avatar={bot.avatar} status={bot.status} ring size={30} />{/snippet}
    </AgentRow>
  {/each}
</section>

<style>
  .agents-rail { width: 280px; max-width: 100%; margin: 20px; background: var(--color-frame); border-radius: var(--radius-lg); padding: 12px; }
  h1 { margin: 0 0 14px; font-size: var(--text-md); }
</style>
