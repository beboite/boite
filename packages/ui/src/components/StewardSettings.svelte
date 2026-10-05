<script lang="ts">
  import { ShieldAlert, UserCog } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import { STEWARD_CAPABILITIES, STEWARD_DEFAULT_CAPABILITIES, type StewardCapability, type StewardGrant, type StewardGrantInput } from '@boite/contracts';
  import { strings } from '../lib/strings';
  import { RISKY_STEWARD_CAPABILITIES } from '../lib/steward';
  import type { Store } from '../lib/store.svelte';

  /**
   * Makes the agent of this thread the steward of projects: it reads, steers
   * and tidies their threads within the capabilities ticked here. The owner
   * edits; a paired device sees the same controls, read-only.
   */
  let { store, threadId }: { store: Store; threadId: string } = $props();

  let thread = $derived(store.threads.find(entry => entry.id === threadId));
  let grant = $derived(store.stewards?.find(entry => entry.threadId === threadId) ?? null);
  let projects = $derived(store.projects.filter(project => !project.archived && project.kind !== 'drafts'));
  /** A delegated child or a persistent session is refused by the core; an archived thread is too. */
  let eligible = $derived(!!thread && !thread.parentThreadId && !thread.agentSessionId && !thread.archived);
  let editable = $derived(store.owner && eligible && !store.stewardsSaving);
  /** On with no project to preselect: the checklist shows, nothing is saved until one is ticked. */
  let choosing = $state(false);
  let on = $derived(grant !== null || choosing);

  onMount(() => { if (store.stewards === null) void store.loadStewards(); });
  $effect(() => { if (grant) choosing = false; });

  function save(patch: Partial<StewardGrantInput>): void {
    if (!editable) return;
    const base: StewardGrantInput = grant
      ? { threadId, projectIds: grant.projectIds, allProjects: grant.allProjects, capabilities: grant.capabilities, notify: grant.notify }
      : { threadId, projectIds: [], allProjects: false, capabilities: [...STEWARD_DEFAULT_CAPABILITIES], notify: true };
    void store.setSteward({ ...base, ...patch });
  }

  function toggle(next: boolean): void {
    if (!editable) return;
    if (!next) {
      choosing = false;
      if (grant) void store.revokeSteward(threadId);
      return;
    }
    const own = projects.find(project => project.id === thread?.projectId);
    if (own) save({ projectIds: [own.id] });
    else choosing = true;
  }

  function project(id: string, checked: boolean): void {
    const current = grant?.projectIds ?? [];
    const next = checked ? [...current.filter(entry => entry !== id), id] : current.filter(entry => entry !== id);
    if (next.length > 0) save({ projectIds: next, allProjects: false });
  }

  function capability(name: StewardCapability, checked: boolean, current: StewardGrant): void {
    save({ capabilities: checked ? [...current.capabilities, name] : current.capabilities.filter(entry => entry !== name) });
  }
</script>

<section class="steward" aria-labelledby="steward-heading-{threadId}" data-testid="steward-settings" data-on={on}>
  <h3 id="steward-heading-{threadId}"><UserCog size={14} strokeWidth={1.75} aria-hidden="true" />{strings.steward.heading}</h3>
  {#if !store.owner}<p class="notice" data-testid="steward-owner-only">{strings.steward.ownerOnly}</p>{/if}
  {#if !eligible && thread}<p class="notice" data-testid="steward-unavailable">{strings.steward.unavailable}</p>{/if}

  <label class="row">
    <span><strong>{strings.steward.enable}</strong><small>{strings.steward.enableHint}</small></span>
    <input type="checkbox" role="switch" checked={on} disabled={!editable} data-testid="steward-enabled"
      onchange={(event) => { const next = event.currentTarget.checked; event.currentTarget.checked = on; toggle(next); }} />
  </label>

  {#if on}
    <label class="row">
      <span><strong>{strings.steward.allProjects}</strong><small>{strings.steward.allProjectsHint}</small></span>
      <input type="checkbox" role="switch" checked={grant?.allProjects ?? false} disabled={!editable} data-testid="steward-all"
        onchange={(event) => { const next = event.currentTarget.checked; event.currentTarget.checked = grant?.allProjects ?? false;
          save(next ? { allProjects: true, projectIds: [] } : { allProjects: false, projectIds: thread?.projectId && projects.some(entry => entry.id === thread?.projectId) ? [thread.projectId] : projects.slice(0, 1).map(entry => entry.id) }); }} />
    </label>

    {#if !grant?.allProjects}
      <fieldset class="group" data-testid="steward-projects">
        <legend>{strings.steward.projects}</legend>
        {#if projects.length === 0}
          <p class="empty">{strings.steward.projectsEmpty}</p>
        {:else}
          <ul class="checks">
            {#each projects as entry (entry.id)}
              {@const checked = grant?.projectIds.includes(entry.id) ?? false}
              <li>
                <label class="check">
                  <input type="checkbox" {checked} data-testid="steward-project" data-project-id={entry.id}
                    disabled={!editable || (checked && grant?.projectIds.length === 1)}
                    onchange={(event) => { const next = event.currentTarget.checked; event.currentTarget.checked = checked; project(entry.id, next); }} />
                  <span><strong>{entry.name}</strong><small>{entry.path}</small></span>
                </label>
              </li>
            {/each}
          </ul>
        {/if}
      </fieldset>
    {/if}

    {#if grant}
      {@const current = grant}
      <fieldset class="group" data-testid="steward-capabilities">
        <legend>{strings.steward.capabilities}</legend>
        <ul class="checks">
          {#each STEWARD_CAPABILITIES as name (name)}
            {@const risky = RISKY_STEWARD_CAPABILITIES.includes(name)}
            {@const checked = current.capabilities.includes(name)}
            <li class:risky>
              <label class="check">
                <input type="checkbox" {checked} disabled={!editable} data-testid="steward-capability" data-capability={name}
                  onchange={(event) => { const next = event.currentTarget.checked; event.currentTarget.checked = checked; capability(name, next, current); }} />
                <span>
                  <strong>{strings.steward.capability[name].label}{#if risky}<span class="risk" data-testid="steward-risky"><ShieldAlert size={12} aria-hidden="true" /><span class="ui-label">{strings.steward.risky}</span></span>{/if}</strong>
                  <small>{strings.steward.capability[name].hint}</small>
                </span>
              </label>
            </li>
          {/each}
        </ul>
      </fieldset>

      <label class="row">
        <span><strong>{strings.steward.notify}</strong><small>{strings.steward.notifyHint}</small></span>
        <input type="checkbox" role="switch" checked={current.notify} disabled={!editable} data-testid="steward-notify"
          onchange={(event) => { const next = event.currentTarget.checked; event.currentTarget.checked = current.notify; save({ notify: next }); }} />
      </label>
    {/if}
  {/if}

  {#if store.stewardsError}<p class="error" role="alert" data-testid="steward-error">{store.stewardsError}</p>{/if}
</section>

<style>
  .steward { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--color-border); }
  h3 { display: flex; align-items: center; gap: 6px; margin: 0; font-size: var(--text-sm); color: var(--color-steward); }
  h3 :global(svg) { flex: none; }
  .notice { margin: 10px 0 0; padding: 8px 10px; border-left: 2px solid var(--color-edge); background: var(--color-surface-2); color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.45; }
  .row { display: flex; align-items: center; gap: 16px; margin-top: 12px; }
  .row > span { flex: 1; min-width: 0; }
  strong, small { display: block; }
  strong { font-size: var(--text-sm); font-weight: 500; color: var(--color-foreground); }
  small { margin-top: 2px; color: var(--color-muted-foreground); font-size: var(--text-xs); line-height: 1.4; overflow-wrap: anywhere; }
  .group { margin: 14px 0 0; padding: 0; border: 0; min-width: 0; }
  legend { padding: 0; margin-bottom: 6px; color: var(--color-muted-foreground); font-size: var(--text-xs); font-weight: 600; }
  .checks { list-style: none; margin: 0; padding: 0; border: 1px solid var(--color-border); border-radius: var(--radius-md); overflow: hidden; }
  .checks li + li { border-top: 1px solid var(--color-border); }
  .check { display: flex; align-items: flex-start; gap: 10px; min-height: var(--control-lg); padding: 8px 10px; cursor: pointer; }
  .check input { flex: none; margin: 2px 0 0; width: 16px; height: 16px; accent-color: var(--color-steward); cursor: inherit; }
  .check input:disabled { cursor: not-allowed; }
  .check > span { flex: 1; min-width: 0; }
  .risky { background: color-mix(in oklch, var(--color-danger) 6%, transparent); }
  .risky .check input { accent-color: var(--color-danger); }
  .risk { display: inline-flex; align-items: center; gap: 3px; margin-left: 8px; padding: 1px 6px; border-radius: var(--radius-sm); vertical-align: 1px; background: color-mix(in oklch, var(--color-danger) 14%, transparent); color: var(--color-danger); font-size: var(--text-xs); font-weight: 500; }
  .empty { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .error { margin-top: 10px; color: var(--color-danger); font-size: var(--text-sm); }
  @media (max-width: 720px) {
    .check { min-height: var(--touch-target); }
  }
</style>
