<script lang="ts">
  import { untrack } from 'svelte';
  import type { DelegationView, PermissionMode, SharedComputeJob, SharedComputePolicy, SharedComputeRoute, SharedProjectScope, SharedProjectView } from '@boite/contracts';
  import type { Store } from '../../lib/store.svelte';
  import { errorText } from '../../lib/errors';
  import { secureId } from '../../lib/secure-id';
  import { sameSharedProject } from '../../lib/shared-ui';
  import { strings } from '../../lib/strings';
  import InfoTip from '../InfoTip.svelte';
  import Menu from '../Menu.svelte';
  import ProviderLogo from '../ProviderLogo.svelte';
  let { store, scope, project }: { store: Store; scope: SharedProjectScope; project: SharedProjectView } = $props();
  let view = $derived(store.shared.view(scope));
  let local = $derived(project.shared.access.find(access => sameSharedProject(access.project, project.local))!);
  let parents = $derived(store.threads.filter(t => t.projectId === project.local.projectId && !t.archived && !t.parentThreadId));
  let parentId = $state(untrack(() => scope.threadId));
  let boundParentId = $state<string | null>(null);
  let hostLoaded = $state(false);
  let delegation = $state<DelegationView | null>(null);
  let hostSide = $state<'local' | 'remote'>('remote');
  let host = $derived(project[hostSide]);
  let hostAccess = $derived(project.shared.access.find(access => sameSharedProject(access.project, host))!);
  let routes = $state<SharedComputeRoute[]>([]);
  let profileId = $state('');
  let task = $state('');
  let base = $state('');
  let error = $state('');
  let busy = $state(false);
  let selected = $state<SharedComputeJob | null>(null);
  let retry: {input: string; requestId: string} | undefined;
  const modes: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'yolo'];
  const terminal = (job: SharedComputeJob) => ['done', 'failed', 'cancelled', 'revoked'].includes(job.status);
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
  $effect(() => {
    const endpoint = host, enabled = hostAccess.compute.enabled, revision = hostAccess.revision;
    routes = []; profileId = '';
    if (!enabled || project.shared.state !== 'active') return;
    let alive = true;
    untrack(() => { void store.shared.call('sharedCompute.models', {...scope, host: endpoint}).then(value => {
      if (alive) { routes = value; profileId = value.find(route => route.protection.supported)?.profileId ?? value[0]?.profileId ?? ''; }
    }).catch(e => { if (alive) error = errorText(e); }); });
    return () => { alive = false; void revision; };
  });
  // Live jobs replace an explicitly followed snapshot; revocation closes every result.
  let followed = $derived.by(() => {
    if (!selected) return null;
    const live = view?.jobs.find(job => job.id === selected!.id);
    return live && live.revision >= selected.revision ? live : selected;
  });
  let offered = $derived([{id: 'conversation', name: store.threads.find(t => t.id === parentId)?.model ?? strings.shared.hostThread}, ...(delegation?.config.profiles ?? [])]);
  function hostName(ref: SharedComputeJob['host']): string {
    const own = sameSharedProject(ref, project.local);
    const machine = view?.threads.find(row => sameSharedProject(row.ref.project, ref))?.machine ?? (own ? store.core?.hostname ?? strings.machines.local : undefined);
    return [own ? strings.shared.you : project.contact.name, machine].filter(Boolean).join(' · ');
  }
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
  async function start() {
    const route = routes.find(r => r.profileId === profileId);
    if (!store.owner || busy || !task.trim() || !route?.protection.supported || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base.trim())) return;
    const params = {...scope, host, profileId, task: task.trim(), baseCommit: base.trim()};
    const input = JSON.stringify(params);
    if (retry?.input !== input) retry = {input, requestId: secureId()};
    busy = true; error = '';
    try { selected = await store.shared.call('sharedCompute.start', {...params, requestId: retry!.requestId}); task = ''; retry = undefined; }
    catch (e) { error = errorText(e); }
    finally { busy = false; }
  }
  async function act(job: SharedComputeJob, cancel = false) {
    if (busy) return;
    busy = true; error = '';
    try { selected = cancel ? await store.shared.call('sharedCompute.cancel', {...scope, jobId: job.id, requestId: secureId()}) : await store.shared.call('sharedCompute.get', {...scope, jobId: job.id}); }
    catch (e) { error = errorText(e); }
    finally { busy = false; }
  }
</script>

<section class="compute" data-testid="shared-compute">
  <h3>{strings.shared.compute}<InfoTip topic={strings.shared.compute} text={strings.shared.computeTip} /></h3>
  {#if store.owner}
    <details class="disclosure" data-testid="shared-host-settings"><summary>{strings.shared.contribute}</summary>
      <div class="row"><span>{strings.shared.hostThread}</span><Menu items={parents.map(t => ({id: t.id, label: t.title}))} onpick={id => { parentId = id; }} disabled={busy || !hostLoaded || local.compute.enabled} label={strings.shared.hostThread} testid="shared-host-thread"><span>{parents.find(t => t.id === parentId)?.title ?? strings.shared.hostThread}</span></Menu></div>
      <div class="profiles"><span>{strings.shared.profiles}</span>{#each offered as profile (profile.id)}<label><input type="checkbox" checked={local.compute.profiles.includes(profile.id)} disabled={busy || !hostLoaded || (local.compute.enabled && local.compute.profiles.length === 1 && local.compute.profiles.includes(profile.id))} data-testid="shared-profile-{profile.id}"
        onchange={e => void configure({profiles: e.currentTarget.checked ? [...local.compute.profiles, profile.id] : local.compute.profiles.filter(id => id !== profile.id)})} /><span>{profile.name}</span></label>{/each}</div>
      <div class="row"><span>{strings.shared.mode}</span><Menu items={modes.map(id => ({id, label: strings.permissionMode[id]}))} onpick={id => void configure({permissionMode: id as PermissionMode})} disabled={busy || !hostLoaded} label={strings.shared.mode} testid="shared-host-mode"><span>{strings.permissionMode[local.compute.permissionMode]}</span></Menu></div>
      <label class="row"><span>{strings.shared.contribution}</span><input type="number" min="1" step="1" value={local.compute.maxConcurrent ?? ''} placeholder={strings.shared.inherited} aria-label={strings.shared.contribution} disabled={busy || !hostLoaded} data-testid="shared-contribution"
        onchange={e => { const input = e.currentTarget; if (input.validity.valid) void configure({maxConcurrent: input.value === '' ? null : input.valueAsNumber}); }} /></label>
      <label class="row"><span>{strings.shared.contribute}</span><input type="checkbox" role="switch" checked={local.compute.enabled} disabled={busy || !hostLoaded || !local.compute.enabled && !local.compute.profiles.length} data-testid="shared-compute-consent" onchange={e => void configure({enabled: e.currentTarget.checked})} /></label>
    </details>
  {:else}<p class="hint">{strings.shared.ownerOnly}</p>{/if}
  <div class="row"><span>{strings.shared.host}</span><Menu items={[{id: 'local', label: hostName(project.local)}, {id: 'remote', label: hostName(project.remote)}]} onpick={id => { hostSide = id as 'local' | 'remote'; }} label={strings.shared.host} testid="shared-compute-host"><span>{hostName(host)}</span></Menu></div>
  {#if !hostAccess.compute.enabled}<p class="hint" data-testid="shared-compute-off">{strings.shared.computeOff}</p>
  {:else}
    <p class="hint" data-testid="shared-host-contribution">{strings.shared.contribution}: {hostAccess.compute.maxConcurrent ?? strings.shared.inherited}</p>
    <div class="routes">{#each routes as route (route.profileId)}<div class="route"><ProviderLogo providerId={route.providerId} size={14} /><span>{route.model ?? route.providerId} · {strings.permissionMode[route.permissionMode]}</span>
      {#if !route.protection.supported}<span class="hint" data-testid="shared-route-unavailable">{strings.shared.unavailable}: {route.protection.reason}</span>{/if}</div>{/each}</div>
    {#if store.owner}<form onsubmit={e => { e.preventDefault(); void start(); }}>
      <Menu items={routes.map(route => ({id: route.profileId, label: route.model ?? route.providerId, disabled: !route.protection.supported}))} onpick={id => { profileId = id; }} label={strings.shared.profiles} testid="shared-compute-route"><span>{routes.find(r => r.profileId === profileId)?.model ?? strings.shared.profiles}</span></Menu>
      <label>{strings.shared.base}<input bind:value={base} pattern={'(?:[a-f0-9]{40}|[a-f0-9]{64})'} required spellcheck="false" data-testid="shared-compute-base" /></label>
      <label>{strings.shared.task}<textarea bind:value={task} rows="2" required maxlength="12000" data-testid="shared-compute-task"></textarea></label>
      <button type="submit" disabled={busy || !task.trim() || !routes.find(r => r.profileId === profileId)?.protection.supported || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base.trim())} data-testid="shared-compute-start">{strings.shared.start}</button>
    </form>{/if}
  {/if}
  <ul class="jobs">{#each view?.jobs ?? [] as job (job.id)}<li data-testid="shared-job" data-job={job.id} data-status={job.status}>
    <div class="job-meta"><span>{hostName(job.host)} · {job.model ?? job.providerId}</span><span>{strings.shared.job[job.status]}</span></div>
    <div class="actions"><button type="button" class="ghost small" disabled={busy} onclick={() => void act(job)} data-testid="shared-job-follow">{strings.shared.follow}</button>{#if !terminal(job)}<button type="button" class="ghost small" disabled={busy} onclick={() => void act(job, true)} data-testid="shared-job-cancel">{strings.shared.cancel}</button>{/if}</div>
  </li>{:else}<li class="hint">{strings.shared.jobsEmpty}</li>{/each}</ul>
  {#if followed && project.shared.state === 'active'}<div class="result" data-testid="shared-job-detail"><span>{strings.shared.job[followed.status]}</span>{#if followed.error}<p>{followed.error}</p>{/if}
    {#if followed.result}<h4>{strings.shared.result}</h4><dl><dt>{strings.shared.branch}</dt><dd>{followed.result.branch}</dd><dt>{strings.shared.commit}</dt><dd>{followed.result.commit}</dd></dl>{#if followed.result.dirty}<p>{strings.shared.dirty}</p>{/if}<p class="text">{followed.result.text}</p>{/if}
  </div>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  h3 { display: flex; align-items: center; gap: 6px; font-size: var(--text-sm); margin: 0 0 10px; }
  summary { cursor: pointer; padding: 8px 0; font-size: var(--text-sm); }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 0; font-size: var(--text-sm); }
  .row > span:first-child { flex: 1; }
  .row input[type='number'] { width: 180px; max-width: 50%; }
  .profiles, form, form label { display: grid; gap: 8px; font-size: var(--text-sm); }
  .profiles { padding-block: 8px; }
  .profiles label { display: flex; gap: 8px; align-items: center; }
  form { margin-top: 12px; } form button { justify-self: start; } textarea, form input { width: 100%; }
  .hint { color: var(--color-muted-foreground); font-size: var(--text-xs); line-height: 1.5; }
  .route { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: var(--text-xs); padding-block: 6px; }
  .route .hint { flex-basis: 100%; }
  .jobs { list-style: none; margin: 12px 0 0; padding: 0; }
  .jobs li { border-top: 1px solid var(--color-border); padding-block: 8px; }
  .job-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; justify-content: space-between; font-size: var(--text-xs); }
  .actions { display: flex; gap: 8px; margin-top: 4px; }
  .result { padding: 10px; background: var(--color-surface-2); border-radius: var(--radius-sm); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .text { white-space: pre-wrap; } dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; } dd { margin: 0; font-family: var(--font-mono); font-size: var(--text-xs); }
  .error { color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
  @media (max-width: 720px) { button, .profiles label { min-height: var(--touch-target); } .row { flex-wrap: wrap; } }
</style>
