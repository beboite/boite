<script lang="ts">
  import { tick } from 'svelte';
  import { Eye, Pencil, Plus, Trash2, X } from '@lucide/svelte';
  import type { Contact, Project } from '@boite/contracts';
  import { initialsOf, splitRequests, type ContactsView } from '../../lib/contacts.svelte';
  import { confirm } from '../../lib/confirm.svelte';
  import { ago, projectName } from '../../lib/format';
  import type { MenuItem } from '../../lib/menu';
  import { fill, strings } from '../../lib/strings';
  import InfoTip from '../InfoTip.svelte';
  import Menu from '../Menu.svelte';
  import ProjectTile from '../ProjectTile.svelte';
  import FingerprintWords from './FingerprintWords.svelte';
  import RequestCard from './RequestCard.svelte';

  /**
   * One contact, picked in the thread list: its name (a click renames it) and
   * how its link stands, what it asks, the projects each side shares with the
   * other, then trust, the eight check words and Remove.
   */
  let { view, contact, now }: { view: ContactsView; contact: Contact; now: number } = $props();
  const labels = $derived(strings.contacts);
  const uid = $props.id();

  const pending = $derived(splitRequests(view.state?.requests.filter(request => request.coreId === contact.coreId) ?? []).pending);
  const projects = $derived(view.store.projects.filter(project => project.kind !== 'drafts'));
  const shared = $derived(contact.grants.map(grant => ({ grant, project: projects.find(project => project.id === grant.projectId) })));
  const unshared = $derived(projects.filter(project => !project.archived && !contact.grants.some(grant => grant.projectId === project.id)));
  const shareItems = $derived<MenuItem[]>(unshared.length
    ? unshared.map(project => ({ id: project.id, label: projectName(project), projectTile: { project, store: view.store } }))
    : [{ id: '', label: labels.noProject, disabled: true }]);

  let editing = $state(false);
  let draft = $state('');
  let field = $state<HTMLInputElement>();
  let nameButton = $state<HTMLButtonElement>();

  async function startRename() {
    draft = contact.name;
    editing = true;
    await tick();
    field?.focus();
    field?.select();
  }
  async function endRename(save: boolean) {
    if (!editing) return;
    editing = false;
    const name = draft.trim();
    if (save && name && name !== contact.name) await view.rename(contact.coreId, name);
    await tick();
    nameButton?.focus();
  }

  function nameOf(project: Project | undefined, projectId: string): string {
    return project ? projectName(project) : projectId;
  }
  async function stopSharing(projectId: string, name: string) {
    const ok = await confirm.ask({
      title: fill(labels.closeTitle, { project: name, name: contact.name }),
      body: fill(labels.closeBody, { name: contact.name }),
      confirmLabel: labels.closeConfirm,
      cancelLabel: labels.requests.cancel,
      danger: true
    });
    if (ok) await view.revoke(contact.coreId, projectId);
  }
  async function remove() {
    const ok = await confirm.ask({
      title: fill(labels.removeTitle, { name: contact.name }),
      body: labels.removeBody,
      confirmLabel: labels.remove,
      cancelLabel: labels.requests.cancel,
      danger: true
    });
    if (!ok) return;
    await view.remove(contact.coreId);
    // Gone from the list, so the page goes back to the one that adds a contact.
    if (!view.state?.contacts.some(entry => entry.coreId === contact.coreId)) view.store.showHome();
  }
</script>

<div class="who" data-link={contact.link} data-testid="contact-{contact.coreId}">
  <span class="avatar" aria-hidden="true">{initialsOf(contact.name)}<span class="dot"></span></span>
  <div class="who-text">
    {#if editing}
      <input class="name-field" bind:this={field} bind:value={draft} aria-label={labels.nameLabel} maxlength="80" data-testid="contact-name-input"
        onkeydown={event => { if (event.key === 'Enter') { event.preventDefault(); void endRename(true); } else if (event.key === 'Escape') { event.preventDefault(); void endRename(false); } }}
        onblur={() => void endRename(true)} />
    {:else}
      <h1><button type="button" class="name" bind:this={nameButton} title={fill(labels.rename, { name: contact.name })} onclick={startRename} data-testid="contact-name">
        <span>{contact.name}</span><Pencil size={13} strokeWidth={2} aria-hidden="true" />
      </button></h1>
    {/if}
    <p>
      <span class="link" data-testid="contact-link" title={contact.lastSeenAt ? fill(labels.lastSeen, { time: ago(contact.lastSeenAt, now) }) : undefined}>{labels.link[contact.link]}</span>
      · <span class="mono">{contact.machine}</span>
    </p>
  </div>
</div>

{#if pending.length}
  <section class="card" data-testid="contact-requests">
    <h2>{labels.requests.title}</h2>
    {#each pending as request (request.id)}<RequestCard {view} {request} {now} />{/each}
  </section>
{/if}

<section class="card" data-testid="contact-shared">
  <h2>{fill(labels.youShare, { name: contact.name })}</h2>
  {#each shared as { grant, project } (grant.projectId)}
    {@const name = nameOf(project, grant.projectId)}
    <div class="switch-row" data-testid="contact-grant-{grant.projectId}">
      <span class="text project">{#if project}<ProjectTile {project} store={view.store} />{/if}<span class="ui-label">{name}</span></span>
      <label class="read" title={labels.readTip}>
        <Eye size={14} strokeWidth={2} aria-hidden="true" /><span class="ui-label">{labels.read}</span>
        <input type="checkbox" role="switch" checked={grant.readThreads} aria-label={fill(labels.readLabel, { name: contact.name, project: name })}
          disabled={view.isBusy(`grant:${contact.coreId}:${grant.projectId}`)} data-testid="contact-read-{grant.projectId}"
          onchange={event => void view.grant(contact.coreId, grant.projectId, event.currentTarget.checked)} />
      </label>
      <button type="button" class="ghost icon" aria-label={fill(labels.closeProject, { project: name })} title={fill(labels.closeProject, { project: name })}
        data-testid="contact-revoke-{grant.projectId}" onclick={() => void stopSharing(grant.projectId, name)}><X size={15} /></button>
    </div>
  {:else}
    <p class="hint none">{labels.nothingOpen}</p>
  {/each}
  <div class="share">
    <Menu items={shareItems} onpick={id => { if (id) void view.grant(contact.coreId, id); }} label={fill(labels.openTo, { name: contact.name })} placement="bottom" variant="chip" testid="contact-open-{contact.coreId}">
      <Plus size={14} /><span class="ui-label">{labels.openProject}</span>
    </Menu>
  </div>
</section>

<section class="card" data-testid="contact-offers">
  <h2>{fill(labels.theyShare, { name: contact.name })}</h2>
  {#each contact.offers as offer (offer.projectId)}
    <div class="switch-row" data-testid="contact-offer-{offer.projectId}">
      <span class="text project"><span class="initial" aria-hidden="true">{initialsOf(offer.name).slice(0, 1)}</span><span class="ui-label">{offer.name}</span></span>
    </div>
  {:else}
    <p class="hint none">{labels.nothingOpen}</p>
  {/each}
</section>

<section class="card">
  <h2>{labels.about}</h2>
  <label class="switch-row" for="{uid}-trusted">
    <span class="text ui-label-box"><span class="ui-label" id="{uid}-trusted-name">{labels.trusted}</span><InfoTip topic={labels.trusted} text={labels.trustedTip} /></span>
    <input id="{uid}-trusted" aria-labelledby="{uid}-trusted-name" type="checkbox" role="switch" checked={contact.trusted} disabled={view.isBusy(`update:${contact.coreId}`)}
      data-testid="contact-trusted" onchange={event => void view.trust(contact.coreId, event.currentTarget.checked)} />
  </label>
  <div class="switch-row stacked">
    <span class="text">
      <span class="ui-label-box"><span class="ui-label">{labels.words}</span><InfoTip topic={labels.words} text={labels.wordsTip} /></span>
      <span class="hint">{labels.role[contact.role]} · {fill(labels.added, { time: ago(contact.addedAt, now) })}</span>
    </span>
    <FingerprintWords fingerprint={contact.fingerprint} testid="contact-words" />
  </div>
  <div class="switch-row">
    <span class="text">
      <span class="ui-label">{labels.remove}</span>
      <span class="hint">{labels.removeHint}</span>
    </span>
    <button type="button" class="danger" disabled={view.isBusy(`remove:${contact.coreId}`)} onclick={() => void remove()} data-testid="contact-remove">
      <Trash2 size={14} /><span class="ui-label">{labels.remove}</span>
    </button>
  </div>
</section>

<style>
  .who { --tone: var(--color-subtle); display: flex; align-items: center; gap: 14px; max-width: var(--settings-width); margin-bottom: 28px; }
  .who[data-link='connected'] { --tone: var(--color-success); }
  .who[data-link='connecting'] { --tone: var(--color-live); }
  .avatar { position: relative; flex: none; display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; background: var(--color-accent-soft); color: var(--color-accent); font-size: var(--text-md); font-weight: 700; }
  .dot { position: absolute; right: 0; bottom: 0; width: 11px; height: 11px; border-radius: 50%; background: var(--tone); box-shadow: 0 0 0 2px var(--color-background); }
  .who-text { display: grid; gap: 4px; min-width: 0; }
  .who h1 { margin: 0; font-size: var(--text-lg); line-height: 1.3; }
  .name { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; height: auto; min-height: 0; padding: 0 6px; margin-left: -6px; border: 0; border-radius: var(--radius-sm); background: none; color: var(--color-foreground); font: inherit; }
  .name span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name :global(svg) { flex: none; opacity: 0; color: var(--color-muted-foreground); transition: opacity var(--dur-2) var(--ease-out-quint); }
  .name:hover { background: var(--color-hover); }
  .name:hover :global(svg), .name:focus-visible :global(svg) { opacity: 1; }
  .name-field { width: min(100%, 280px); font-size: var(--text-lg); font-weight: 600; }
  .who p { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .link { color: var(--tone); font-weight: 500; }
  .mono { font-family: var(--font-mono); font-size: var(--text-xs); }
  .project { display: flex; align-items: center; gap: 8px; }
  .project .ui-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .initial { display: grid; flex: none; place-items: center; width: 18px; height: 18px; border-radius: var(--radius-sm); background: var(--color-accent-soft); color: var(--color-accent); font-size: var(--text-xs); font-weight: 700; }
  .read { display: inline-flex; flex: none; align-items: center; gap: 6px; color: var(--color-muted-foreground); font-size: var(--text-sm); cursor: pointer; }
  .none { margin: 0 0 12px; }
  .share { padding-top: 12px; }
  .switch-row + .share { border-top: 1px solid var(--color-border); }
  .share :global(.trigger) { gap: 6px; }
  /* The eight words take the row's width under its words, as keycaps. */
  :global(.settings .page) .stacked { flex-direction: column; align-items: stretch; gap: 12px; }
  @media (prefers-reduced-motion: reduce) { .name :global(svg) { transition: none; } }
  :global(html[data-motion='reduced']) .name :global(svg) { transition: none; }
  @media (max-width: 720px) {
    .who { margin-bottom: 20px; }
    .name :global(svg) { opacity: 1; }
    .switch-row button.icon { width: var(--touch-target); height: var(--touch-target); }
  }
</style>
