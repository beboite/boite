<script lang="ts">
  import { untrack } from 'svelte';
  import { Plus } from '@lucide/svelte';
  import type { SharedComputeJob, SharedComputeRoute, SharedProjectScope, SharedProjectView } from '@boite/contracts';
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
  const uid = $props.id();
  let composing = $state(false);
  let formOpen = $derived(composing || !view?.jobs.length);
  let retry: {input: string; requestId: string} | undefined;
  const terminal = (job: SharedComputeJob) => ['done', 'failed', 'cancelled', 'revoked'].includes(job.status);
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
  function hostName(ref: SharedComputeJob['host']): string {
    const own = sameSharedProject(ref, project.local);
    const machine = view?.threads.find(row => sameSharedProject(row.ref.project, ref))?.machine ?? (own ? store.core?.hostname ?? strings.machines.local : undefined);
    return [own ? strings.shared.you : project.contact.name, machine].filter(Boolean).join(' · ');
  }
  async function start() {
    const route = routes.find(r => r.profileId === profileId);
    if (!store.owner || busy || !task.trim() || !route?.protection.supported || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base.trim())) return;
    const params = {...scope, host, profileId, task: task.trim(), baseCommit: base.trim()};
    const input = JSON.stringify(params);
    if (retry?.input !== input) retry = {input, requestId: secureId()};
    busy = true; error = '';
    try { selected = await store.shared.call('sharedCompute.start', {...params, requestId: retry!.requestId}); task = ''; retry = undefined; composing = false; }
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
  {#if store.owner && view?.jobs.length}<button type="button" class="ghost small" aria-expanded={formOpen} aria-controls={uid} onclick={() => { composing = !formOpen; }} data-testid="shared-new-task"><Plus size={14} />{strings.shared.newTask}</button>{/if}
  <div id={uid} hidden={!formOpen}>
  <div class="row"><span>{strings.shared.host}<InfoTip topic={strings.shared.compute} text={strings.shared.computeTip} /></span><Menu items={[{id: 'local', label: hostName(project.local)}, {id: 'remote', label: hostName(project.remote)}]} onpick={id => { hostSide = id as 'local' | 'remote'; }} label={strings.shared.host} testid="shared-compute-host"><span>{hostName(host)}</span></Menu></div>
  {#if !hostAccess.compute.enabled}<p class="hint" data-testid="shared-compute-off">{strings.shared.computeOff}</p>
  {:else}
    <p class="hint" data-testid="shared-host-contribution">{strings.shared.contribution}: {hostAccess.compute.maxConcurrent ?? strings.shared.inherited}</p>
    {#if store.owner}<form oninput={() => { composing = true; }} onsubmit={e => { e.preventDefault(); void start(); }}>
      <label>{strings.shared.task}<textarea bind:value={task} rows="3" required maxlength="12000" placeholder={strings.shared.taskPlaceholder} data-testid="shared-compute-task"></textarea></label>
      <div class="route-picker"><ProviderLogo providerId={routes.find(r => r.profileId === profileId)?.providerId ?? ''} size={14} />
        <Menu items={routes.map(route => ({id: route.profileId, label: `${route.model ?? route.providerId} · ${strings.permissionMode[route.permissionMode]}`, disabled: !route.protection.supported}))} onpick={id => { profileId = id; }} label={strings.shared.profiles} testid="shared-compute-route"><span>{routes.find(r => r.profileId === profileId)?.model ?? strings.shared.profiles}</span></Menu>
      </div>
      {#each routes as route (route.profileId)}{#if !route.protection.supported}<p class="hint" data-testid="shared-route-unavailable">{route.model ?? route.providerId}: {route.protection.reason}</p>{/if}{/each}
      <label><span>{strings.shared.base}<InfoTip topic={strings.shared.base} text={strings.shared.baseTip} /></span><input bind:value={base} pattern={'(?:[a-f0-9]{40}|[a-f0-9]{64})'} required spellcheck="false" data-testid="shared-compute-base" /></label>
      <button type="submit" disabled={busy || !task.trim() || !routes.find(r => r.profileId === profileId)?.protection.supported || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base.trim())} data-testid="shared-compute-start">{strings.shared.start}</button>
    </form>{/if}
  {/if}
  </div>
  <ul class="jobs">{#each view?.jobs ?? [] as job (job.id)}<li data-testid="shared-job" data-job={job.id} data-status={job.status}>
    <div class="job-meta"><span>{hostName(job.host)} · {job.model ?? job.providerId}</span><span>{strings.shared.job[job.status]}</span></div>
    <div class="actions"><button type="button" class="ghost small" disabled={busy} onclick={() => void act(job)} data-testid="shared-job-follow">{strings.shared.follow}</button>{#if !terminal(job)}<button type="button" class="ghost small" disabled={busy} onclick={() => void act(job, true)} data-testid="shared-job-cancel">{strings.shared.cancel}</button>{/if}</div>
  </li>{:else}<li class="hint">{strings.shared.jobsEmpty}</li>{/each}</ul>
  {#if followed && project.shared.state === 'active'}<div class="result" data-testid="shared-job-detail"><span>{strings.shared.job[followed.status]}</span>{#if followed.error}<p>{followed.error}</p>{/if}
    {#if followed.result}<h4>{strings.shared.result}</h4><p class="text">{followed.result.text}</p>{#if followed.result.dirty}<p>{strings.shared.dirty}</p>{/if}<details class="disclosure" data-testid="shared-job-metadata"><summary>{strings.shared.gitDetails}</summary><dl><dt>{strings.shared.branch}</dt><dd>{followed.result.branch}</dd><dt>{strings.shared.commit}</dt><dd>{followed.result.commit}</dd></dl></details>{/if}
  </div>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  summary { cursor: pointer; padding: 8px 0; font-size: var(--text-xs); }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 0; font-size: var(--text-sm); }
  .row > span:first-child { flex: 1; }
  form, form label { display: grid; gap: 8px; font-size: var(--text-sm); }
  form { margin-top: 12px; } form button { justify-self: start; } textarea, form input { width: 100%; }
  .hint { color: var(--color-muted-foreground); font-size: var(--text-xs); line-height: 1.5; }
  .route-picker { display: flex; align-items: center; gap: 6px; }
  .jobs { list-style: none; margin: 12px 0 0; padding: 0; }
  .jobs li { border-top: 1px solid var(--color-border); padding-block: 8px; }
  .job-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; justify-content: space-between; font-size: var(--text-xs); }
  .actions { display: flex; gap: 8px; margin-top: 4px; }
  .result { padding: 10px; background: var(--color-surface-2); border-radius: var(--radius-sm); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .text { white-space: pre-wrap; } dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; } dd { margin: 0; font-family: var(--font-mono); font-size: var(--text-xs); }
  .error { color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
  @media (max-width: 720px) { button { min-height: var(--touch-target); } .row { flex-wrap: wrap; } }
</style>
