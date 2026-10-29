<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { Eye, Pencil, Plus, SquareKanban, Trash2, X } from '@lucide/svelte';
  import type { Contact, Project, ProjectId } from '@boite/contracts';
  import { BOARD_COLUMNS, columnCounts } from '../../lib/board';
  import { grantKey, initialsOf, splitRequests, watchContacts, type ContactsView } from '../../lib/contacts.svelte';
  import { confirm } from '../../lib/confirm.svelte';
  import { ago, projectName } from '../../lib/format';
  import type { Store } from '../../lib/store.svelte';
  import { fill, strings } from '../../lib/strings';
  import { workspace, type Machine } from '../../lib/workspace.svelte';
  import InfoTip from '../InfoTip.svelte';
  import MachineIcon from '../MachineIcon.svelte';
  import ProjectChoice from '../ProjectChoice.svelte';
  import ProjectTile from '../ProjectTile.svelte';
  import FingerprintWords from './FingerprintWords.svelte';
  import MailCard from './MailCard.svelte';
  import RequestCard from './RequestCard.svelte';
  import SharedAssociations from '../shared/SharedAssociations.svelte';

  /**
   * One contact, picked in the thread list: its name (a click renames it) and
   * how its link stands, its messages waiting for you, what it asks, the projects each side shares with the
   * other (yours with their board's cards per column), then trust, the eight
   * check words and Remove.
   */
  let { view, contact, now }: { view: ContactsView; contact: Contact; now: number } = $props();
  const labels = $derived(strings.contacts);
  const uid = $props.id();

  const pending = $derived(splitRequests(view.state?.requests.filter(request => request.coreId === contact.coreId) ?? []).pending);
  const mail = $derived(view.state?.mail?.filter(letter => letter.coreId === contact.coreId) ?? []);
  const machines = $derived(workspace.machinesOr(view.store).filter(machine => machine.store.owner));
  const watched = watchContacts(() => machines);
  // A contact's core identity, never its local nickname, links its copies on our machines.
  const links = $derived(watched().flatMap(entry => {
    const linked = entry.view.state?.contacts.find(candidate => candidate.coreId === contact.coreId);
    return linked ? [{ ...entry, contact: linked }] : [];
  }));
  /** A machine of a linked machine's group: the linked one answers the contact for its projects (`docs/contacts.md`). */
  function linkFor(machine: Machine): (typeof links)[number] | undefined {
    const direct = links.find(entry => entry.machine.store === machine.store);
    if (direct) return direct;
    const group = machine.store.group;
    if (!group?.self) return undefined;
    const grouped = links.filter(entry => entry.machine.store.group?.id === group.id && entry.machine.store.connection === 'ready');
    return grouped.find(entry => entry.view === view) ?? grouped[0];
  }
  const shareMachines = $derived(machines.filter(machine => machine.store.connection === 'ready' && linkFor(machine) !== undefined));
  /** A grant names the member that holds its project; none, the linked machine itself. */
  function homeOf(entry: (typeof links)[number], machineId: string | undefined): Machine | undefined {
    return machineId ? machines.find(machine => machine.store.group?.self === machineId) : entry.machine;
  }
  const shared = $derived(links.flatMap(entry => entry.contact.grants.map(grant => {
    const home = homeOf(entry, grant.machine);
    return {
      ...entry, grant, home,
      project: home?.store.projects.find(project => project.id === grant.projectId),
      board: home?.store.projectBoardThread(grant.projectId) ?? null
    };
  })));
  function unshared(owner: Store): Project[] {
    const machine = machines.find(entry => entry.store === owner);
    if (!machine || !linkFor(machine)) return [];
    return owner.projects.filter(project => project.kind !== 'drafts' && !project.archived && !shared.some(entry => entry.home?.store === owner && entry.grant.projectId === project.id));
  }
  async function share(owner: Store, project: Project) {
    const machine = machines.find(entry => entry.store === owner);
    const link = machine ? linkFor(machine) : undefined;
    if (!link || owner.connection !== 'ready' || link.machine.store.connection !== 'ready') return;
    const target = link.view;
    await target.grant(contact.coreId, project.id, undefined, link.machine.store === owner ? undefined : owner.group?.self);
    // Errors from another machine belong on the page where the action started.
    view.error = target.error;
  }
  /**
   * Projects whose cards were read since the connection last became ready;
   * `todos.updated` keeps them current after. A reconnect may have missed an
   * update, so it reads them again, and a read that failed is tried again.
   */
  const read = new WeakMap<Store, Set<ProjectId>>();
  $effect(() => {
    for (const machine of machines) if (machine.store.connection !== 'ready') read.delete(machine.store);
    for (const { home, grant, board } of shared) {
      if (!home) continue;
      const owner = home.store;
      if (owner.connection !== 'ready' || !board) continue;
      let loaded = read.get(owner);
      if (!loaded) { loaded = new Set(); read.set(owner, loaded); }
      const projectId = grant.projectId;
      if (loaded.has(projectId)) continue;
      loaded.add(projectId);
      const seen = loaded;
      untrack(() => {
        const before = owner.todos[projectId];
        void owner.loadTodos(board.id).then(() => { if (owner.todos[projectId] === before) seen.delete(projectId); });
      });
    }
  });

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
  async function stopSharing(owner: ContactsView, projectId: string, machine: string | undefined, name: string) {
    const ok = await confirm.ask({
      title: fill(labels.closeTitle, { project: name, name: contact.name }),
      body: fill(labels.closeBody, { name: contact.name }),
      confirmLabel: labels.closeConfirm,
      cancelLabel: labels.requests.cancel,
      danger: true
    });
    if (ok) { await owner.revoke(contact.coreId, projectId, machine); view.error = owner.error; }
  }
  async function readAccess(owner: ContactsView, projectId: string, machine: string | undefined, checked: boolean) {
    await owner.grant(contact.coreId, projectId, checked, machine);
    view.error = owner.error;
  }
  async function openBoard(owner: Store, projectId: ProjectId) {
    if (workspace.active !== owner) await workspace.select(owner);
    await owner.openProjectBoard(projectId);
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

{#if mail.length}
  <section class="card" data-testid="contact-mail">
    <h2 class="ui-label-box"><span class="ui-label">{labels.mail.title}</span><InfoTip topic={labels.mail.title} text={labels.mail.tip} /></h2>
    {#each mail as letter (letter.id)}<MailCard {view} {letter} {now} />{/each}
  </section>
{/if}

{#if pending.length}
  <section class="card" data-testid="contact-requests">
    <h2>{labels.requests.title}</h2>
    {#each pending as request (request.id)}<RequestCard {view} {request} {now} />{/each}
  </section>
{/if}

<section class="card" data-testid="contact-shared">
  <h2>{fill(labels.youShare, { name: contact.name })}</h2>
  {#each shared as { grant, project, machine, home, view: owner, board } (JSON.stringify([machine.id, grant.machine ?? null, grant.projectId]))}
    {@const name = nameOf(project, grant.name ?? grant.projectId)}
    {@const busy = machine.store.connection !== 'ready' || owner.isBusy(grantKey(contact.coreId, grant.projectId, grant.machine))}
    <div class="switch-row grant" data-testid="contact-grant-{grant.projectId}" data-machine-id={home?.id ?? grant.machine}>
      <span class="text project">{#if project && home}<ProjectTile {project} store={home.store} />{/if}<span class="ui-label">{name}</span>{#if home && machines.length > 1}<span class="machine"><MachineIcon icon={home.icon} os={home.store.core?.os} size={12} /><span class="ui-label">{home.label}</span></span>{/if}</span>
      {#if board && home}
        {@const counts = columnCounts(home.store.todos[grant.projectId] ?? [])}
        {@const summary = BOARD_COLUMNS.map(column => `${strings.board.columns[column]} ${counts[column]}`).join(', ')}
        <button type="button" class="ghost board" title={`${fill(labels.board, { project: name })}: ${summary}`} aria-label={`${fill(labels.board, { project: name })}: ${summary}`}
          data-testid="contact-board-{grant.projectId}" onclick={() => void openBoard(home.store, grant.projectId)}>
          <SquareKanban size={14} strokeWidth={2} aria-hidden="true" />
          {#each BOARD_COLUMNS as column (column)}<span class="tally" data-column={column} class:zero={counts[column] === 0}>{counts[column]}</span>{/each}
        </button>
      {/if}
      <label class="read" title={labels.readTip}>
        <Eye size={14} strokeWidth={2} aria-hidden="true" /><span class="ui-label">{labels.read}</span>
        <input type="checkbox" role="switch" checked={grant.readThreads} aria-label={fill(labels.readLabel, { name: contact.name, project: name })}
          disabled={busy} data-testid="contact-read-{grant.projectId}"
          onchange={event => void readAccess(owner, grant.projectId, grant.machine, event.currentTarget.checked)} />
      </label>
      <button type="button" class="ghost icon" aria-label={fill(labels.closeProject, { project: name })} title={fill(labels.closeProject, { project: name })}
        disabled={busy}
        data-testid="contact-revoke-{grant.projectId}" onclick={() => void stopSharing(owner, grant.projectId, grant.machine, name)}><X size={15} /></button>
    </div>
    {#if home}<SharedAssociations store={home.store} contact={owner.state?.contacts.find(c => c.coreId === contact.coreId) ?? contact} projectId={grant.projectId} />{/if}
  {:else}
    <p class="hint none">{labels.nothingOpen}</p>
  {/each}
  <div class="share">
    <ProjectChoice store={view.store} selection={{ machines: shareMachines, projects: unshared, onpick: (owner, project) => void share(owner, project), label: fill(labels.openTo, { name: contact.name }), empty: labels.noProject }} testid="contact-open-{contact.coreId}">
      <Plus size={14} /><span class="ui-label">{labels.openProject}</span>
    </ProjectChoice>
  </div>
</section>

<section class="card" data-testid="contact-offers">
  <h2>{fill(labels.theyShare, { name: contact.name })}</h2>
  {#each contact.offers as offer (JSON.stringify([offer.sharedProject?.ownerCoreId ?? contact.coreId, offer.sharedProject?.coreId ?? contact.coreId, offer.projectId]))}
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
  .machine { display: inline-flex; align-items: center; gap: 4px; min-width: 0; margin-left: auto; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .machine :global(svg) { flex: none; }
  .initial { display: grid; flex: none; place-items: center; width: 18px; height: 18px; border-radius: var(--radius-sm); background: var(--color-accent-soft); color: var(--color-accent); font-size: var(--text-xs); font-weight: 700; }
  /* The board's columns as four counts, each in its column's tone: to do, in progress, in review, done. */
  .board { display: inline-flex; flex: none; align-items: center; gap: 6px; height: 28px; padding: 0 8px; border-radius: var(--radius-sm); color: var(--color-muted-foreground); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .tally { min-width: 1ch; font-weight: 600; text-align: center; }
  .tally[data-column='doing'] { color: var(--color-live); }
  .tally[data-column='review'] { color: var(--color-accent); }
  .tally[data-column='done'] { color: var(--color-success); }
  .tally.zero { color: var(--color-subtle); font-weight: 400; }
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
    .board { height: var(--touch-target); }
    /* The name takes the first line whole; the board, Read and Stop sharing go under it. */
    .grant { flex-wrap: wrap; row-gap: 4px; }
    .switch-row.grant .project { flex: 1 0 100%; }
    .grant .board { margin: 0 auto 0 -8px; }
  }
</style>
