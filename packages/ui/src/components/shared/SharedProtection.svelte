<script lang="ts">
  import type { SharedFileOverride, SharedProjectScope, SharedProjectView, SharedReviewConfig } from '@boite/contracts';
  import type { Choice, PickPatch, Store } from '../../lib/store.svelte';
  import { errorText } from '../../lib/errors';
  import { exactTime } from '../../lib/format';
  import { secureId } from '../../lib/secure-id';
  import { fill, strings } from '../../lib/strings';
  import InfoTip from '../InfoTip.svelte';
  import ModelPicker from '../ModelPicker.svelte';
  let { store, scope, project }: { store: Store; scope: SharedProjectScope; project: SharedProjectView } = $props();
  let view = $derived(store.shared.view(scope));
  let open = $state(false);
  let config = $state<SharedReviewConfig>({enabled: false});
  let overrides = $state<SharedFileOverride[]>([]);
  let busy = $state(false);
  let error = $state('');
  let path = $state(''), reason = $state(''), expires = $state(''), jobId = $state('');
  let read = $state(true), publish = $state(false);
  let choice = $state<Choice | null>(null);
  let retry: {input: string; requestId: string} | undefined;
  $effect(() => {
    if (!open || !store.owner) return;
    let alive = true;
    const parent = store.threads.find(t => t.id === scope.threadId);
    if (parent) choice = {providerId: parent.providerId, accountId: parent.accountId, model: parent.model, effort: parent.effort ?? null, permissionMode: 'default'};
    void Promise.all([store.shared.call('sharedAccess.reviewConfig', {sharedProjectId: scope.sharedProjectId}), store.shared.call('sharedAccess.overrides', {sharedProjectId: scope.sharedProjectId})]).then(([review, files]) => {
      if (!alive) return;
      config = review; overrides = files;
      if (review.enabled) choice = {...review, permissionMode: 'default'};
    }).catch(e => { if (alive) error = errorText(e); });
    return () => { alive = false; };
  });
  async function review(next: SharedReviewConfig) {
    if (!store.owner || busy) return;
    busy = true; error = '';
    try { await store.shared.call('sharedProjects.configure', {sharedProjectId: scope.sharedProjectId, reviewer: next}); config = next; }
    catch (e) { error = errorText(e); }
    finally { busy = false; }
  }
  function pick(patch: PickPatch) {
    if (!choice || busy) return;
    choice = {...choice, ...patch};
    if (config.enabled) void review({...config, providerId: choice.providerId, accountId: choice.accountId, model: choice.model, effort: choice.effort});
  }
  async function add() {
    if (!store.owner || busy || !path.trim() || !reason.trim() || !expires || (!read && !publish)) return;
    const override = {path: path.trim(), reason: reason.trim(), expiresAt: new Date(expires).getTime(), jobId: jobId.trim() || null, actions: [...(read ? ['read' as const] : []), ...(publish ? ['publish' as const] : [])]};
    const input = JSON.stringify(override);
    if (retry?.input !== input) retry = {input, requestId: secureId()};
    busy = true; error = '';
    try { const saved = await store.shared.call('sharedAccess.override', {sharedProjectId: scope.sharedProjectId, override, requestId: retry!.requestId}); overrides = [...overrides, saved]; path = ''; reason = ''; retry = undefined; }
    catch (e) { error = errorText(e); }
    finally { busy = false; }
  }
  async function revoke(overrideId: string) {
    if (busy) return;
    busy = true; error = '';
    try { await store.shared.call('sharedAccess.revokeOverride', {sharedProjectId: scope.sharedProjectId, overrideId}); overrides = overrides.filter(o => o.id !== overrideId); }
    catch (e) { error = errorText(e); }
    finally { busy = false; }
  }
</script>

<section class="protection" data-testid="shared-protection">
  <h3>{strings.shared.protection}</h3>
  <p class="summary" data-testid="shared-protection-state">{strings.shared.denied} · {fill(strings.shared.overrides, {count: String(project.protection.activeOverrides)})}</p>
  <p class="summary" data-testid="shared-review-state">{strings.shared.reviewer}: {strings.shared.review[project.protection.reviewer]}</p>
  <details class="disclosure" bind:open><summary>{strings.shared.protection}</summary>
    {#if store.owner}
      <label class="row"><span>{strings.shared.reviewer}<InfoTip topic={strings.shared.reviewer} text={strings.shared.reviewTip} /></span><input type="checkbox" role="switch" aria-label={strings.shared.reviewer} checked={config.enabled} disabled={busy || !choice} data-testid="shared-review-consent"
        onchange={e => void review(e.currentTarget.checked && choice ? {enabled: true, providerId: choice.providerId, accountId: choice.accountId, model: choice.model, effort: choice.effort, revokeOnViolation: false} : {enabled: false})} /></label>
      {#if choice}<ModelPicker {store} {choice} disabled={busy} onpick={pick} />{/if}
      {#if config.enabled}<label class="row"><span>{strings.shared.autoRevoke}</span><input type="checkbox" role="switch" checked={config.revokeOnViolation} disabled={busy} data-testid="shared-review-revoke" onchange={e => { if (config.enabled) void review({...config, revokeOnViolation: e.currentTarget.checked}); }} /></label>{/if}
      <details class="disclosure"><summary>{strings.shared.exceptions}</summary>
        <ul>{#each overrides.filter(o => !o.revokedAt) as override (override.id)}<li data-testid="shared-override"><span>{override.path} · {override.reason} · {exactTime(override.expiresAt)}</span><button type="button" class="ghost small" disabled={busy} onclick={() => void revoke(override.id)}>{strings.shared.revokeException}</button></li>{/each}</ul>
        <form onsubmit={e => { e.preventDefault(); void add(); }}>
          <label>{strings.shared.path}<input bind:value={path} required data-testid="shared-override-path" /></label>
          <label>{strings.shared.reason}<input bind:value={reason} required data-testid="shared-override-reason" /></label>
          <label>{strings.shared.expires}<input type="datetime-local" bind:value={expires} required data-testid="shared-override-expires" /></label>
          <label>{strings.shared.jobId}<input bind:value={jobId} /></label>
          <label class="check"><input type="checkbox" bind:checked={read} />{strings.shared.allowRead}</label><label class="check"><input type="checkbox" bind:checked={publish} />{strings.shared.allowPublish}</label>
          <button type="submit" disabled={busy || (!read && !publish)} data-testid="shared-override-add">{strings.shared.addException}</button>
        </form>
      </details>
    {:else}<p class="summary">{strings.shared.ownerOnly}</p>{/if}
    <h4>{strings.shared.audit}</h4>
    <ul data-testid="shared-access-events">{#each view?.access?.events ?? [] as event (event.id)}<li><span>{event.decision === 'allowed' ? strings.shared.allowed : strings.shared.blocked} · {event.reason}<small>{exactTime(event.at)}</small></span></li>{:else}<li class="summary">{strings.shared.auditEmpty}</li>{/each}</ul>
    <ul>{#each view?.access?.verdicts ?? [] as verdict (verdict.id)}<li data-testid="shared-review-verdict"><span>{strings.shared.verdict[verdict.verdict]} · {verdict.reason}{#if verdict.action === 'revoked'} · {strings.shared.state.revoked}{/if}</span></li>{/each}</ul>
    <div class="actions"><button type="button" class="ghost small" onclick={() => void store.shared.accessPage(scope)}>{strings.shared.first}</button>{#if view?.access?.next}<button type="button" class="ghost small" onclick={() => void store.shared.accessPage(scope, view?.access?.next ?? undefined)}>{strings.shared.next}</button>{/if}</div>
  </details>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  h3, h4 { font-size: var(--text-sm); margin: 0 0 8px; } h4 { margin-top: 16px; }
  .summary, small { color: var(--color-muted-foreground); font-size: var(--text-xs); line-height: 1.5; }
  summary { padding: 8px 0; cursor: pointer; font-size: var(--text-sm); }
  .row, .row > span { display: flex; align-items: center; gap: 8px; } .row { justify-content: space-between; padding-block: 8px; font-size: var(--text-sm); }
  form, form label { display: grid; gap: 8px; font-size: var(--text-sm); } form { margin-block: 12px; } form input { width: 100%; }
  form label.check { display: flex; align-items: center; } .check input { width: auto; } form button { justify-self: start; }
  ul { list-style: none; padding: 0; margin: 8px 0; } li { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: 6px; padding-block: 8px; border-top: 1px solid var(--color-border); font-size: var(--text-xs); overflow-wrap: anywhere; } small { display: block; }
  .actions { display: flex; gap: 8px; } .error { color: var(--color-danger); font-size: var(--text-sm); }
  @media (max-width: 720px) { button, label.check { min-height: var(--touch-target); } }
</style>
