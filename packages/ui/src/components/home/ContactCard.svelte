<script lang="ts">
  import { tick } from 'svelte';
  import { Eye, Pencil, Plus, Trash2, X } from '@lucide/svelte';
  import type { Contact, Project } from '@boite/contracts';
  import { initialsOf, type ContactsView } from '../../lib/contacts.svelte';
  import { confirm } from '../../lib/confirm.svelte';
  import { ago, projectName, time } from '../../lib/format';
  import type { MenuItem } from '../../lib/menu';
  import { fill, strings } from '../../lib/strings';
  import InfoTip from '../InfoTip.svelte';
  import Menu from '../Menu.svelte';
  import ProjectTile from '../ProjectTile.svelte';
  import FingerprintWords from './FingerprintWords.svelte';

  /**
   * One contact: its badge and name (a click renames it), its machine, how its
   * link stands and whether it is trusted, then the projects each side opened
   * to the other. The four words and Remove wait under Details.
   */
  let { view, contact, now }: { view: ContactsView; contact: Contact; now: number } = $props();
  const labels = $derived(strings.contacts);
  const uid = $props.id();

  const projects = $derived(view.store.projects.filter(project => project.kind !== 'drafts'));
  const opened = $derived(contact.grants.map(grant => ({ grant, project: projects.find(project => project.id === grant.projectId) })));
  const closed = $derived(projects.filter(project => !project.archived && !contact.grants.some(grant => grant.projectId === project.id)));
  const openItems = $derived<MenuItem[]>(closed.length
    ? closed.map(project => ({ id: project.id, label: projectName(project), projectTile: { project, store: view.store } }))
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
  async function close(projectId: string, name: string) {
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
    if (ok) await view.remove(contact.coreId);
  }
</script>

<article class="contact" data-link={contact.link} data-testid="contact-{contact.coreId}">
  <header class="head">
    <span class="badge" aria-hidden="true">{initialsOf(contact.name)}<span class="dot"></span></span>
    <div class="who">
      {#if editing}
        <input class="name-field" bind:this={field} bind:value={draft} aria-label={labels.nameLabel} maxlength="80" data-testid="contact-name-input"
          onkeydown={event => { if (event.key === 'Enter') { event.preventDefault(); void endRename(true); } else if (event.key === 'Escape') { event.preventDefault(); void endRename(false); } }}
          onblur={() => void endRename(true)} />
      {:else}
        <button type="button" class="name" bind:this={nameButton} title={fill(labels.rename, { name: contact.name })} onclick={startRename} data-testid="contact-name">
          <span class="ui-label">{contact.name}</span><Pencil size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      {/if}
      <span class="machine">{contact.machine}</span>
    </div>
    <span class="link" data-testid="contact-link" title={contact.lastSeenAt ? fill(labels.lastSeen, { time: ago(contact.lastSeenAt, now) }) : undefined}>
      <span class="pip"></span><span class="ui-label">{labels.link[contact.link]}</span>
    </span>
  </header>

  <label class="trust" for="{uid}-trusted">
    <span class="ui-label-box"><span class="ui-label" id="{uid}-trusted-name">{labels.trusted}</span><InfoTip topic={labels.trusted} text={labels.trustedTip} /></span>
    <input id="{uid}-trusted" aria-labelledby="{uid}-trusted-name" type="checkbox" role="switch" checked={contact.trusted} disabled={view.isBusy(`update:${contact.coreId}`)}
      data-testid="contact-trusted" onchange={event => void view.trust(contact.coreId, event.currentTarget.checked)} />
  </label>

  <div class="lanes">
    <section class="lane" aria-label={labels.youOpened}>
      <h4 class="section-label">{labels.youOpened}</h4>
      <div class="chips">
        {#each opened as { grant, project } (grant.projectId)}
          {@const name = nameOf(project, grant.projectId)}
          <span class="grant" data-testid="contact-grant-{grant.projectId}">
            {#if project}<ProjectTile {project} store={view.store} size={16} />{/if}
            <span class="grant-name">{name}</span>
            <label class="read" title={labels.readTip}>
              <Eye size={13} strokeWidth={2} aria-hidden="true" />
              <span class="read-word">{labels.read}</span>
              <input type="checkbox" role="switch" class="mini" checked={grant.readThreads} aria-label={fill(labels.readLabel, { name: contact.name, project: name })}
                disabled={view.isBusy(`grant:${contact.coreId}:${grant.projectId}`)} data-testid="contact-read-{grant.projectId}"
                onchange={event => void view.grant(contact.coreId, grant.projectId, event.currentTarget.checked)} />
            </label>
            <button type="button" class="ghost icon close" aria-label={fill(labels.closeProject, { project: name })} title={fill(labels.closeProject, { project: name })}
              data-testid="contact-revoke-{grant.projectId}" onclick={() => void close(grant.projectId, name)}><X size={13} /></button>
          </span>
        {/each}
        <span class="add">
          <Menu items={openItems} onpick={id => { if (id) void view.grant(contact.coreId, id); }} label={fill(labels.openTo, { name: contact.name })} placement="bottom" variant="chip" testid="contact-open-{contact.coreId}">
            <Plus size={14} /><span class="ui-label">{labels.openProject}</span>
          </Menu>
        </span>
      </div>
    </section>
    <section class="lane" aria-label={labels.theyOpened}>
      <h4 class="section-label">{labels.theyOpened}</h4>
      <div class="chips">
        {#each contact.offers as offer (offer.projectId)}
          <span class="offer" data-testid="contact-offer-{offer.projectId}"><span class="initial" aria-hidden="true">{initialsOf(offer.name).slice(0, 1)}</span>{offer.name}</span>
        {:else}
          <span class="nothing">{labels.nothingOpen}</span>
        {/each}
      </div>
    </section>
  </div>

  <details class="disclosure more">
    <summary>{labels.details}</summary>
    <div class="details-body">
      <div class="words-head ui-label-box"><span class="section-label">{labels.words}</span><InfoTip topic={labels.words} text={labels.wordsTip} /></div>
      <FingerprintWords fingerprint={contact.fingerprint} testid="contact-words" />
      <p class="facts">{labels.role[contact.role]} · {fill(labels.added, { time: time(contact.addedAt) })}</p>
      <button type="button" class="ghost danger remove" disabled={view.isBusy(`remove:${contact.coreId}`)} onclick={() => void remove()} data-testid="contact-remove">
        <Trash2 size={14} /><span class="ui-label">{labels.remove}</span>
      </button>
    </div>
  </details>
</article>

<style>
  .contact {
    --tone: var(--color-subtle);
    position: relative;
    display: grid;
    gap: 14px;
    padding: 16px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    box-shadow: var(--shadow-e1);
    overflow: hidden;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }
  .contact[data-link='connected'] { --tone: var(--color-success); }
  .contact[data-link='connecting'] { --tone: var(--color-live); }
  /* A wash of the accent behind the badge: the card reads as someone, not a settings row. */
  .contact::before {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(260px 150px at 38px 38px, color-mix(in oklch, var(--color-accent) 22%, transparent), transparent);
    pointer-events: none;
  }
  .head { position: relative; display: flex; align-items: center; gap: 12px; min-width: 0; }
  .badge {
    position: relative;
    flex: none;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: var(--radius-lg);
    background: linear-gradient(145deg, color-mix(in oklch, var(--color-accent) 85%, white), color-mix(in oklch, var(--color-accent) 70%, black));
    color: var(--color-accent-ink);
    font-size: var(--text-md);
    font-weight: 700;
    letter-spacing: 0.02em;
    box-shadow: 0 6px 18px color-mix(in oklch, var(--color-accent) 35%, transparent), inset 0 1px 0 rgb(255 255 255 / 0.35);
  }
  .dot { position: absolute; right: -3px; bottom: -3px; width: 12px; height: 12px; border-radius: 50%; background: var(--tone); box-shadow: 0 0 0 3px var(--color-surface); }
  .who { flex: 1; min-width: 0; display: grid; gap: 2px; justify-items: start; }
  .name { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: auto; min-height: 0; padding: 2px 6px; margin-left: -6px; border: 0; border-radius: var(--radius-sm); background: none; color: var(--color-foreground); font-size: var(--text-md); font-weight: 600; }
  .name .ui-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name :global(svg) { flex: none; opacity: 0; color: var(--color-muted-foreground); transition: opacity var(--dur-2) var(--ease-out-quint); }
  .name:hover { background: var(--color-hover); }
  .name:hover :global(svg), .name:focus-visible :global(svg) { opacity: 1; }
  .name-field { width: min(100%, 260px); height: var(--control); font-size: var(--text-md); font-weight: 600; }
  .machine { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-subtle); font-family: var(--font-mono); font-size: var(--text-xs); }
  .link {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--control-sm);
    padding: 0 10px;
    border-radius: var(--radius-full);
    background: color-mix(in oklch, var(--tone) 14%, transparent);
    color: var(--tone);
    font-size: var(--text-xs);
    font-weight: 600;
  }
  .pip { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .contact[data-link='connecting'] .pip { animation: pulse 1.6s var(--ease-out-quint) infinite; }
  .trust { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border-radius: var(--radius-md); background: var(--color-surface-2); font-weight: 500; }
  .lanes { position: relative; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
  .lane { display: grid; gap: 8px; align-content: start; min-width: 0; }
  .lane h4 { margin: 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
  .grant, .offer {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    min-height: var(--control);
    padding: 0 4px 0 8px;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    font-size: var(--text-sm);
  }
  .grant-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .read { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: var(--radius-sm); background: var(--color-surface-3); color: var(--color-muted-foreground); font-size: var(--text-xs); cursor: pointer; }
  .read:has(input:checked) { background: var(--color-accent-soft); color: var(--color-accent); }
  .mini { --switch-width: 24px; --switch-height: 14px; }
  .close { width: var(--control-sm); height: var(--control-sm); color: var(--color-muted-foreground); }
  .add :global(.trigger) { height: var(--control); gap: 6px; padding: 0 10px; border: 1px dashed var(--color-edge); border-radius: var(--radius-md); background: transparent; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .add :global(.trigger:hover) { border-color: var(--color-accent); color: var(--color-foreground); }
  .offer { padding: 0 10px 0 4px; border-color: color-mix(in oklch, var(--color-accent) 40%, transparent); background: var(--color-accent-soft); color: var(--color-foreground); font-weight: 500; }
  .initial { display: grid; place-items: center; width: 22px; height: 22px; border-radius: var(--radius-sm); background: var(--color-accent); color: var(--color-accent-ink); font-size: var(--text-xs); font-weight: 700; }
  .nothing { color: var(--color-subtle); font-size: var(--text-sm); line-height: var(--control); }
  .more { position: relative; }
  .more > summary { width: max-content; }
  .details-body { display: grid; gap: 10px; padding-top: 10px; }
  .words-head { display: flex; align-items: center; gap: 4px; }
  .facts { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .remove { justify-self: start; color: var(--color-danger); }
  .remove:hover:not(:disabled) { background: color-mix(in oklch, var(--color-danger) 12%, transparent); }
  @media (prefers-reduced-motion: reduce) { .contact, .contact[data-link='connecting'] .pip { animation: none; } }
  :global(html[data-motion='reduced']) .contact, :global(html[data-motion='reduced']) .contact[data-link='connecting'] .pip { animation: none; }
  @media (max-width: 720px) {
    .contact { padding: 14px; }
    .close { width: var(--touch-target); height: var(--touch-target); }
    .name :global(svg) { opacity: 1; }
    .lanes { grid-template-columns: minmax(0, 1fr); }
  }
</style>
