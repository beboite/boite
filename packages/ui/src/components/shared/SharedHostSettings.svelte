<script lang="ts">
  import { untrack } from 'svelte';
  import type { DelegationView, PermissionMode, SharedComputePolicy, SharedProjectScope, SharedProjectView } from '@boite/contracts';
  import type { Store } from '../../lib/store.svelte';
  import { errorText } from '../../lib/errors';
  import { sameSharedProject } from '../../lib/shared-ui';
  import { strings } from '../../lib/strings';
  import InfoTip from '../InfoTip.svelte';
  import Menu from '../Menu.svelte';
  let { store, scope, project }: { store: Store; scope: SharedProjectScope; project: SharedProjectView } = $props();
  let local = $derived(project.shared.access.find(access => sameSharedProject(access.project, project.local))!);
  let parents = $derived(store.threads.filter(t => t.projectId === project.local.projectId && !t.archived && !t.parentThreadId));
  let parentId = $state(untrack(() => scope.threadId));
  let boundParentId = $state<string | null>(null);
  let hostLoaded = $state(false);
  let delegation = $state<DelegationView | null>(null);
  let busy = $state(false), error = $state('');
  const modes: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'yolo'];
  $effect(() => {
    const client = store.client, sharedProjectId = scope.sharedProjectId, fallback = scope.threadId;
    hostLoaded = false;
    if (!store.owner || !client) return;
    let alive = true;
    void client.call('sharedCompute.host', {sharedProjectId}).then(value => {
      if (!alive) return;
      boundParentId = value.threadId; parentId = value.threadId ?? fallback; hostLoaded = true;
    }).catch(e => { if (alive) error = errorText(e); });
    return () => { alive = false; };
  });
  $effect(() => {
    const client = store.client, id = parentId;
    if (!store.owner || !client || !hostLoaded) return;
    let alive = true;
    delegation = null;
    void client.call('delegation.get', {threadId: id}).then(value => { if (alive) delegation = value; }).catch(e => { if (alive) error = errorText(e); });
    return () => { alive = false; };
  });
  let offered = $derived([{id: 'conversation', name: store.threads.find(t => t.id === parentId)?.model ?? strings.shared.hostThread}, ...(delegation?.config.profiles ?? [])]);
  async function configure(patch: Partial<SharedComputePolicy>) {
    if (!store.owner || busy || !hostLoaded) return;
    busy = true; error = '';
    const compute = {...local.compute, ...patch};
    const rebind = compute.enabled && parentId !== boundParentId;
    try {
      await store.shared.call('sharedProjects.configure', {sharedProjectId: scope.sharedProjectId, compute, ...(rebind ? {computeThreadId: parentId} : {})});
      if (rebind) boundParentId = parentId;
    }
    catch (e) { error = errorText(e); }
    finally { busy = false; }
  }
</script>

<section class="hosting">
  <label class="row consent"><span>{strings.shared.contribute}<InfoTip topic={strings.shared.contribute} text={strings.shared.computeTip} /></span>
    <input type="checkbox" role="switch" checked={local.compute.enabled} disabled={busy || !hostLoaded || !local.compute.enabled && !local.compute.profiles.length} data-testid="shared-compute-consent" onchange={e => void configure({enabled: e.currentTarget.checked})} />
  </label>
  {#if !local.compute.profiles.length}<p class="hint">{strings.shared.chooseAgent}</p>{/if}
  <details class="disclosure" data-testid="shared-host-settings"><summary>{strings.shared.hostSettings}</summary>
    <div class="row"><span>{strings.shared.hostThread}</span><Menu items={parents.map(t => ({id: t.id, label: t.title}))} onpick={id => { parentId = id; }} disabled={busy || !hostLoaded || local.compute.enabled} label={strings.shared.hostThread} testid="shared-host-thread"><span>{parents.find(t => t.id === parentId)?.title ?? strings.shared.hostThread}</span></Menu></div>
    <div class="profiles"><span>{strings.shared.profiles}</span>{#each offered as profile (profile.id)}<label><input type="checkbox" checked={local.compute.profiles.includes(profile.id)} disabled={busy || !hostLoaded || (local.compute.enabled && local.compute.profiles.length === 1 && local.compute.profiles.includes(profile.id))} data-testid="shared-profile-{profile.id}"
      onchange={e => void configure({profiles: e.currentTarget.checked ? [...local.compute.profiles, profile.id] : local.compute.profiles.filter(id => id !== profile.id)})} /><span>{profile.name}</span></label>{/each}</div>
    <div class="row"><span>{strings.shared.mode}</span><Menu items={modes.map(id => ({id, label: strings.permissionMode[id]}))} onpick={id => void configure({permissionMode: id as PermissionMode})} disabled={busy || !hostLoaded} label={strings.shared.mode} testid="shared-host-mode"><span>{strings.permissionMode[local.compute.permissionMode]}</span></Menu></div>
    <label class="row"><span>{strings.shared.contribution}</span><input type="number" min="1" step="1" value={local.compute.maxConcurrent ?? ''} placeholder={strings.shared.inherited} aria-label={strings.shared.contribution} disabled={busy || !hostLoaded} data-testid="shared-contribution"
      onchange={e => { const input = e.currentTarget; if (input.validity.valid) void configure({maxConcurrent: input.value === '' ? null : input.valueAsNumber}); }} /></label>
  </details>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 0; font-size: var(--text-sm); }
  .row > span:first-child { flex: 1; min-width: 0; }
  .row input[type='number'] { width: 180px; max-width: 50%; }
  .consent { padding-block: 12px; }
  summary { cursor: pointer; padding: 10px 0; font-size: var(--text-sm); }
  .profiles { display: grid; gap: 8px; padding-block: 8px; font-size: var(--text-sm); }
  .profiles label { display: flex; gap: 8px; align-items: center; }
  .hint { margin: 0 0 8px; color: var(--color-muted-foreground); font-size: var(--text-xs); line-height: 1.5; }
  .error { color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
  @media (max-width: 720px) { .profiles label, summary { min-height: var(--touch-target); } .row { flex-wrap: wrap; } }
</style>
