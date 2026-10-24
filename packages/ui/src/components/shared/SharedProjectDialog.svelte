<script lang="ts">
  import { untrack } from 'svelte';
  import type { SharedProjectScope } from '@boite/contracts';
  import type { Store } from '../../lib/store.svelte';
  import { errorText } from '../../lib/errors';
  import { secureId } from '../../lib/secure-id';
  import { sameSharedProject } from '../../lib/shared-ui';
  import { strings } from '../../lib/strings';
  import SharedDialog from './SharedDialog.svelte';
  import SharedCompute from './SharedCompute.svelte';
  import SharedProtection from './SharedProtection.svelte';
  let { store, scope, onclose }: { store: Store; scope: SharedProjectScope; onclose: () => void } = $props();
  let view = $derived(store.shared.view(scope));
  let project = $derived(view?.project);
  let error = $state('');
  let busy = $state(false);
  let confirming = $state(false);
  $effect(() => { const captured = scope; return untrack(() => store.shared.watch(captured, ['threads', 'compute', 'access'])); });
  async function configure(board: boolean) {
    if (!store.owner || busy) return;
    busy = true; error = '';
    try { await store.shared.call('sharedProjects.configure', {sharedProjectId: scope.sharedProjectId, board}); }
    catch (e) { error = errorText(e); }
    finally { busy = false; }
  }
  async function revoke() {
    if (!store.owner || busy) return;
    busy = true; error = '';
    try { await store.shared.call('sharedProjects.revoke', {sharedProjectId: scope.sharedProjectId, requestId: secureId()}); }
    catch (e) { error = errorText(e); }
    finally { busy = false; }
  }
</script>

<SharedDialog title={project ? `${strings.shared.heading} · ${project.contact.name}` : strings.shared.heading} {onclose} testid="shared-project-dialog">
  {#if project}
    <p class="state" data-testid="shared-project-state">{strings.shared.state[project.shared.state]}{#if project.connection !== 'connected'} · {strings.shared.offline}{/if}</p>
    {#if project.shared.state === 'active'}
      {@const local = project.shared.access.find(access => sameSharedProject(access.project, project.local))!}
      <label class="row"><span>{strings.shared.boardConsent}</span><input type="checkbox" role="switch" checked={local.board} disabled={!store.owner || busy} data-testid="shared-board-consent" onchange={e => void configure(e.currentTarget.checked)} /></label>
      {#if !project.shared.access.every(access => access.board)}<p class="state">{strings.shared.boardWaiting}</p>{/if}
      <SharedCompute {store} {scope} {project} />
      <SharedProtection {store} {scope} {project} />
      {#if store.owner}
        {#if confirming}<div class="revoke" role="alertdialog" aria-label={strings.shared.revokeTitle}>
          <p>{strings.shared.revokeBody}</p><div class="actions"><button type="button" class="ghost" disabled={busy} onclick={() => { confirming = false; }} data-testid="shared-revoke-cancel">{strings.contacts.requests.cancel}</button><button type="button" class="destructive" disabled={busy} onclick={() => void revoke()} data-testid="shared-revoke-confirm">{strings.shared.revoke}</button></div>
        </div>{:else}<button type="button" class="danger" disabled={busy} onclick={() => { confirming = true; }} data-testid="shared-project-revoke">{strings.shared.revoke}</button>{/if}
      {/if}
    {/if}
  {:else if !view?.error}<p>{strings.parts.loading}</p>{/if}
  {#if error || view?.error}<p class="error" role="alert">{error || view?.error}</p>{/if}
</SharedDialog>

<style>
  .state { margin: 0 0 12px; color: var(--color-muted-foreground); font-size: var(--text-xs); line-height: 1.5; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: var(--text-sm); margin-bottom: 12px; }
  :global(.body > .compute), :global(.body > .protection) { padding-block: 16px; border-top: 1px solid var(--color-border); }
  .error { color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .revoke { padding: 12px; background: var(--color-surface-2); border-radius: var(--radius-md); font-size: var(--text-sm); }
  .actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
  @media (max-width: 720px) { button { min-height: var(--touch-target); } }
</style>
