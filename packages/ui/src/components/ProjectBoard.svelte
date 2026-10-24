<script lang="ts">
  import { untrack } from 'svelte';
  import { MessagesSquare, Play, Plus } from '@lucide/svelte';
  import type { SharedBoardCommand, SharedProjectThread, ThreadId, Todo } from '@boite/contracts';
  import { BOARD_COLUMNS, cardColumn, type BoardColumn } from '../lib/board';
  import { separator, type MenuItem } from '../lib/menu';
  import { fill, strings } from '../lib/strings';
  import { experimentOn } from '../lib/experiments.svelte';
  import { errorText } from '../lib/errors';
  import { secureId } from '../lib/secure-id';
  import { sameSharedProject, sharedTodo } from '../lib/shared-ui';
  import type { Store } from '../lib/store.svelte';
  import GoalChecklist from './GoalChecklist.svelte';
  import InfoTip from './InfoTip.svelte';
  import Menu from './Menu.svelte';
  import ProviderLogo from './ProviderLogo.svelte';

  /**
   * The project's todos in four columns. To do holds the cards nobody works
   * on; a card put In progress starts a `/goal2` conversation on it, and its
   * bar is that goal's checklist; In review holds a goal under review and the
   * cards an agent or a passed review left for the user to confirm; Done is
   * what the user confirmed. A card moves by drag on a desktop and by its
   * menu anywhere. A phone shows one column a screen, swiped like a home
   * screen, with a dot per column under it.
   */
  let { store, threadId, narrow }: { store: Store; threadId: ThreadId; narrow: boolean } = $props();

  type Column = BoardColumn;
  const COLUMNS = BOARD_COLUMNS;

  let projectId = $derived(store.openThread?.projectId ?? null);
  let sharedProjectId = $derived(store.shared.boards[threadId]);
  let scope = $derived(sharedProjectId ? {threadId, sharedProjectId} : null);
  let shared = $derived(scope ? store.shared.view(scope) : undefined);
  let projects = $derived((store.shared.projects[threadId] ?? []).filter(p => p.shared.state === 'active'));
  let todos = $derived(scope ? (shared?.board ?? []).map(card => sharedTodo(card, projectId ?? '', scope!.sharedProjectId)) : (projectId ? store.todos[projectId] ?? [] : []).filter(todo => !todo.shared));
  let error = $state('');
  /** Cards whose conversation is being made: they sit In progress from the drop. */
  let starting = $state<string[]>([]);
  let unfolded = $state<string[]>([]);
  let dragged = $state<string | null>(null);
  let over = $state<Column | null>(null);
  let adding = $state(false);
  let draft = $state('');
  let board = $state<HTMLElement | undefined>(undefined);
  let page = $state(0);
  let selected = $state<SharedProjectThread | null>(null);
  type BoardEdit = {kind: 'update'; text?: string; status?: Todo['status']} | {kind: 'release'; claimId: string} | {kind: 'remove'};

  $effect(() => {
    if (projectId) untrack(() => void store.loadTodos(threadId));
  });
  $effect(() => {
    if (experimentOn('contacts') && store.connection === 'ready') untrack(() => { void store.shared.load(threadId).catch(e => { error = errorText(e); }); });
  });
  $effect(() => { const captured = scope; if (captured) return untrack(() => store.shared.watch(captured, ['board', 'threads'])); });
  async function apply(todo: Todo, command: BoardEdit) {
    if (!scope) return;
    const receipt = await store.shared.call('sharedBoard.apply', {...scope, command: {...command, cardId: todo.id, requestId: secureId()} as SharedBoardCommand});
    if (!['applied', 'queued'].includes(receipt.outcome)) throw new Error(strings.shared.conflict);
  }

  function localWorker(todo: Todo): boolean {
    return !todo.shared || Boolean(shared?.project && todo.shared.card.assignment && sameSharedProject(todo.shared.card.assignment.worker.project, shared.project.local));
  }

  function foreignWorker(todo: Todo): SharedProjectThread | undefined {
    const worker = todo.shared?.card.assignment?.worker;
    return worker ? shared?.threads.find(row => store.shared.threadKey(row.ref) === store.shared.threadKey(worker)) : undefined;
  }

  async function resume(todo: Todo): Promise<void> {
    if (scope && todo.shared?.card.assignment && localWorker(todo)) await store.shared.call('sharedBoard.start', {...scope, threadId: todo.shared.card.assignment.worker.threadId, cardId: todo.id, claimId: todo.shared.card.assignment.claimId});
    else if (!scope) await store.resumeCardGoal(threadId, todo);
  }

  function columnOf(todo: Todo): Column {
    return starting.includes(todo.id) ? 'doing' : cardColumn(todo);
  }

  /** In progress with no goal on its conversation: a start cut short, or the goal removed there. */
  function stalled(todo: Todo): boolean {
    return Boolean(todo.goalThreadId) && !todo.goal && todo.status === 'open' && !starting.includes(todo.id);
  }

  let columns = $derived(COLUMNS.map((column) => ({ column, cards: todos.filter((todo) => columnOf(todo) === column) })));

  async function move(todo: Todo, to: Column): Promise<void> {
    if (columnOf(todo) === to) return;
    if (narrow) goTo(COLUMNS.indexOf(to));
    if (scope && todo.shared) {
      error = '';
      starting = [...starting, todo.id];
      try {
        if (to === 'doing' && !todo.shared.card.assignment) await store.shared.startCard(scope, todo.shared.card);
        else if (to === 'doing' && localWorker(todo) && ['reserved', 'uncertain'].includes(todo.shared.card.assignment!.state)) await resume(todo);
        else if (to === 'todo' && todo.shared.card.assignment) await apply(todo, {kind: 'release', claimId: todo.shared.card.assignment.claimId});
        else await apply(todo, {kind: 'update', status: to === 'done' ? 'done' : to === 'review' ? 'claimed' : 'open'});
      } catch (e) { error = errorText(e); }
      finally { starting = starting.filter(id => id !== todo.id); }
      return;
    }
    if (to === 'doing' && !todo.goalThreadId) {
      starting = [...starting, todo.id];
      try { await store.startCardGoal(threadId, todo); }
      finally { starting = starting.filter((id) => id !== todo.id); }
      return;
    }
    if (to === 'todo') await store.updateTodo(threadId, todo.id, { status: 'open', ...(todo.goalThreadId ? { goalThreadId: null } : {}) });
    else await store.updateTodo(threadId, todo.id, { status: to === 'doing' ? 'open' : to === 'review' ? 'claimed' : 'done' });
  }

  function actions(todo: Todo): MenuItem[] {
    const here = columnOf(todo);
    return [
      ...COLUMNS.filter((column) => column !== here).map((column) => ({ id: `move:${column}`, label: fill(strings.board.moveTo, { column: strings.board.columns[column] }), disabled: Boolean(scope && !shared?.authorityAvailable && (column === 'doing' || column === 'todo' && todo.shared?.card.assignment)) })),
      ...(todo.goalThreadId ? [separator('sep-thread'), ...(stalled(todo) && localWorker(todo) ? [{ id: 'resume', label: strings.board.resume, glyph: Play }] : []),
        { id: 'open', label: strings.board.openThread, glyph: MessagesSquare, disabled: !localWorker(todo) && !foreignWorker(todo) }] : []),
      separator('sep-remove'),
      { id: 'remove', label: strings.board.remove, danger: true }
    ];
  }

  function pick(todo: Todo, id: string): void {
    if (id.startsWith('move:')) void move(todo, id.slice(5) as Column);
    else if (id === 'open' && todo.goalThreadId) { if (localWorker(todo)) void store.open(todo.goalThreadId); else selected = foreignWorker(todo) ?? null; }
    else if (id === 'resume') void resume(todo).catch(e => { error = errorText(e); });
    else if (id === 'remove') { if (scope) void apply(todo, {kind: 'remove'}).catch(e => { error = errorText(e); }); else void store.removeTodo(threadId, todo.id); }
  }

  /** The agent on a card's goal: its model, the machine it runs on, and whether a turn is running. */
  function agentOf(todo: Todo): { providerId: string; label: string; running: boolean } | null {
    if (todo.shared?.card.assignment) {
      const assignment = todo.shared.card.assignment, project = shared?.project;
      const own = project && sameSharedProject(assignment.worker.project, project.local);
      const info = assignment.workerInfo;
      return {providerId: info?.agent.split(' ')[0] ?? '', label: [own ? strings.shared.you : project?.contact.name, info?.machine, info?.agent].filter(Boolean).join(' · '), running: assignment.state === 'running'};
    }
    const thread = todo.goalThreadId ? store.threads.find((entry) => entry.id === todo.goalThreadId) : undefined;
    if (!thread) return null;
    const model = thread.model ? store.providers.find((provider) => provider.id === thread.providerId)?.models.find((entry) => entry.id === thread.model)?.name ?? thread.model : null;
    const machine = store.core?.hostname;
    return { providerId: thread.providerId, label: [model, machine].filter(Boolean).join(' · '), running: thread.status === 'running' };
  }

  async function add(): Promise<void> {
    const text = draft.trim();
    if (!text) { adding = false; return; }
    error = '';
    try {
      if (scope) {
        const receipt = await store.shared.call('sharedBoard.apply', {...scope, command: {kind: 'add', text, cardId: secureId(), requestId: secureId()}});
        if (!['applied', 'queued'].includes(receipt.outcome)) throw new Error(strings.shared.conflict);
      } else await store.addTodo(threadId, text);
      draft = '';
    } catch (e) { error = errorText(e); }
  }

  function toggle(todo: Todo): void {
    unfolded = unfolded.includes(todo.id) ? unfolded.filter((id) => id !== todo.id) : [...unfolded, todo.id];
  }

  function onScroll(): void {
    if (board && board.clientWidth > 0) page = Math.round(board.scrollLeft / board.clientWidth);
  }

  function goTo(index: number): void {
    if (!board) return;
    page = index;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'reduced';
    board.scrollTo({ left: index * board.clientWidth, behavior: reduced ? 'auto' : 'smooth' });
  }

  function drop(event: DragEvent, column: Column): void {
    event.preventDefault();
    const todo = todos.find((entry) => entry.id === dragged);
    dragged = null;
    over = null;
    if (todo) void move(todo, column);
  }

  function focusOnMount(node: HTMLInputElement): void {
    node.focus();
  }
</script>

{#if projects.length || scope}
  <div class="sharing" data-testid="board-sharing">
    <Menu items={[{id: '', label: strings.shared.local}, ...projects.map(p => ({id: p.shared.id, label: fill(strings.shared.with, {name: p.contact.name})}))]} label={strings.shared.board} testid="board-sharing-menu" onpick={id => { store.shared.boards[threadId] = id || undefined; }}>
      <span>{scope ? fill(strings.shared.with, {name: shared?.project?.contact.name ?? ''}) : strings.shared.local}</span>
    </Menu>
    {#if scope && shared?.project?.shared.state === 'revoked'}<span>{strings.shared.state.revoked}</span>
    {:else if scope && !shared?.project?.shared.access.every(a => a.board)}<span>{strings.shared.boardWaiting}</span>
    {:else if scope && !shared?.authorityAvailable}<span role="status">{strings.shared.authorityUnavailable}</span>{/if}
  </div>
{/if}
{#if error || shared?.error}<p class="board-error" role="alert" data-testid="board-error">{error || shared?.error}</p>{/if}
<div class="board" class:pager={narrow} bind:this={board} onscroll={narrow ? onScroll : undefined} data-testid="project-board">
  {#each columns as { column, cards } (column)}
    <section class="column" class:over={over === column} data-column={column} data-testid="board-column"
      aria-label={strings.board.columns[column]}
      ondragover={(event) => { if (dragged) { event.preventDefault(); over = column; } }}
      ondragleave={(event) => { if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) over = null; }}
      ondrop={(event) => drop(event, column)}>
      <header class="column-head">
        <span class="ui-label">{strings.board.columns[column]}</span>
        {#if column === 'doing'}<InfoTip topic={strings.board.columns.doing} text={strings.board.doingHint} testid="board-doing-hint" />{/if}
        <span class="count ui-label" data-testid="board-count">{cards.length}</span>
      </header>
      <ul class="cards">
        {#each cards as todo (todo.id)}
          {@const agent = agentOf(todo)}
          {@const listed = todo.goal?.checklist?.items.filter((item) => item.status !== 'cancelled') ?? []}
          {@const ticked = listed.filter((item) => item.status === 'done').length}
          {@const open = unfolded.includes(todo.id) && todo.goal?.checklist}
          <li class="card" class:done={column === 'done'} class:lifted={dragged === todo.id} draggable={!narrow}
            data-testid="board-card" data-todo={todo.id}
            ondragstart={(event) => { dragged = todo.id; event.dataTransfer?.setData('text/plain', todo.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; }}
            ondragend={() => { dragged = null; over = null; }}>
            <div class="card-head">
              {#if todo.goal?.checklist}
                <button type="button" class="ghost text" aria-expanded={Boolean(open)} data-testid="board-card-text" onclick={() => toggle(todo)}>{todo.text}</button>
              {:else}
                <span class="text" data-testid="board-card-text">{todo.text}</span>
              {/if}
              <Menu items={actions(todo)} onpick={(id) => pick(todo, id)} variant="ghost" placement="bottom" align="end" label={strings.board.actions} testid="board-card-menu">
                <span class="dots" aria-hidden="true">···</span>
              </Menu>
            </div>
            {#if agent}
              <span class="agent ui-label" data-testid="board-card-agent">
                <ProviderLogo providerId={agent.providerId} size={12} />
                <span class="agent-label">{agent.label}</span>
                {#if agent.running}<span class="running" aria-hidden="true"></span>{/if}
              </span>
            {/if}
            {#if todo.shared?.card.pending}<span class="state muted ui-label">{strings.shared.queued}</span>{/if}
            {#if todo.shared?.card.assignment?.state === 'reserved' || todo.shared?.card.assignment?.state === 'uncertain'}<span class="state muted ui-label">{todo.shared.card.assignment.state === 'reserved' ? strings.shared.reserved : strings.shared.uncertain}</span>{/if}
            {#if listed.length > 0}
              <div class="progress-row" data-testid="board-card-progress">
                <progress max={listed.length} value={ticked} aria-hidden="true"></progress>
                <span class="meta ui-label">{fill(strings.activity.checklistCount, { done: String(ticked), total: String(listed.length) })}</span>
              </div>
            {/if}
            {#if starting.includes(todo.id)}
              <span class="state muted ui-label" data-testid="board-card-state">{strings.board.starting}</span>
            {:else if todo.goal?.reviewing}
              <span class="state review ui-label" data-testid="board-card-state">{strings.board.reviewing}</span>
            {:else if todo.status === 'claimed'}
              <span class="state awaiting ui-label" data-testid="board-card-state">{strings.board.awaiting}</span>
            {:else if stalled(todo)}
              <span class="state muted ui-label" data-testid="board-card-state">{strings.board.stalled}</span>
            {/if}
            {#if open && todo.goal?.checklist}
              <div class="checklist"><GoalChecklist {store} checklist={todo.goal.checklist} dense /></div>
            {/if}
          </li>
        {/each}
      </ul>
      {#if column === 'todo' && (!scope || shared?.project?.shared.state === 'active' && shared.project.shared.access.every(a => a.board))}
        {#if adding}
          <form class="add-form" onsubmit={(event) => { event.preventDefault(); void add(); }}>
            <input class="add-input" bind:value={draft} placeholder={strings.board.addPlaceholder} aria-label={strings.board.add} data-testid="board-add-input"
              use:focusOnMount
              onkeydown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); draft = ''; adding = false; } }}
              onblur={() => { if (!draft.trim()) adding = false; }} />
          </form>
        {:else}
          <button type="button" class="ghost small add" data-testid="board-add" onclick={() => (adding = true)}>
            <Plus size={13} strokeWidth={1.75} /><span class="ui-label">{strings.board.add}</span>
          </button>
        {/if}
      {/if}
    </section>
  {/each}
</div>
{#if narrow}
  <div class="pages" role="tablist" aria-label={strings.board.pages} data-testid="board-pages">
    {#each columns as { column, cards }, index (column)}
      <button type="button" role="tab" class="page" class:on={page === index} aria-selected={page === index}
        aria-label={fill(strings.board.page, { column: strings.board.columns[column], count: String(cards.length) })}
        data-testid="board-page" onclick={() => goTo(index)}></button>
    {/each}
  </div>
{/if}

{#if selected && scope}{#await import('./shared/SharedThreadDialog.svelte') then module}<module.default {store} {scope} target={selected} onclose={() => { selected = null; }} />{/await}{/if}

<style>
  .sharing { display: flex; gap: 8px; align-items: center; padding: 2px 12px; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .sharing > span { min-width: 0; overflow-wrap: anywhere; }
  .board-error { padding: 0 12px; margin: 4px 0; font-size: var(--text-xs); color: var(--color-danger); }
  .board {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 8px;
    padding: 8px 10px 10px;
    overflow-x: auto;
    overscroll-behavior-x: contain;
  }

  /* A phone: one column a screen, swiped and snapped like a home screen's pages. */
  .board.pager {
    gap: 0;
    padding: 6px 0 0;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
  }

  .board.pager::-webkit-scrollbar { display: none; }

  /* Four columns fit beside the contacts column on a 1280 px window; narrower, the board scrolls. */
  .column {
    flex: 1 1 0;
    min-width: 168px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 6px;
    border-radius: var(--radius-md);
    background: color-mix(in oklab, var(--color-surface-3) 55%, transparent);
    transition: box-shadow var(--dur-1) var(--ease-out-quint);
  }

  .pager .column {
    flex: 0 0 100%;
    min-width: 0;
    scroll-snap-align: start;
    scroll-snap-stop: always;
    background: none;
    padding: 0 12px;
  }

  .column.over { box-shadow: inset 0 0 0 1px var(--color-accent); }

  /* One height with or without the "i", so every column's first card starts on the same line. */
  .column-head {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
    height: 22px;
    padding: 0 4px 4px;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--color-muted-foreground);
  }

  .pager .column-head { font-size: var(--text-sm); padding: 2px 0 8px; }

  .count { margin-left: auto; font-variant-numeric: tabular-nums; }

  /* A column longer than the drawer fades its last card out instead of cutting
     it through a line. The fade is the bottom padding, so at rest it covers
     nothing (the same mask as the sidebar's rows). */
  .cards {
    list-style: none;
    margin: 0;
    padding: 0 0 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 0;
    overflow-y: auto;
    mask-image: linear-gradient(to bottom, black calc(100% - 10px), transparent);
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: none;
    padding: 8px 6px 8px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    font-size: var(--text-sm);
    line-height: 1.4;
  }

  .card[draggable='true'] { cursor: grab; }
  .card[draggable='true']:hover { border-color: var(--color-edge); }
  .card.lifted { opacity: 0.5; }
  .card.done .text { color: var(--color-muted-foreground); }

  .card-head {
    display: flex;
    align-items: flex-start;
    gap: 4px;
  }

  .text {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
    text-align: left;
    color: var(--color-foreground);
  }

  /* The text that unfolds the checklist reads as the card's text, not as a button. */
  /* A button keeps its text on one line; a card's wraps like the others. */
  button.text {
    display: block;
    white-space: normal;
    justify-content: flex-start;
    padding: 0;
    height: auto;
    border: none;
    font: inherit;
    font-weight: inherit;
    line-height: inherit;
    background: none;
    cursor: pointer;
  }

  .card button.text:is(:hover, :active, :focus):not(:disabled) { background: none; color: var(--color-foreground); }

  .dots {
    font-size: var(--text-sm);
    letter-spacing: -1px;
    line-height: 1;
    color: var(--color-muted-foreground);
  }

  .card-head :global(.trigger) {
    height: 20px;
    min-width: 24px;
    padding: 0 4px;
    margin-top: -1px;
  }

  .agent {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  .agent-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .running {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-live);
    animation: running 1.2s var(--loop-ease-out-quint-36) infinite var(--loops);
  }

  @keyframes running {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  @media (prefers-reduced-motion: reduce) { .running { animation: none; } }
  :global(html[data-motion='reduced']) .running { animation: none; }

  .progress-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  progress {
    flex: 1;
    min-width: 0;
    appearance: none;
    height: 4px;
    border: none;
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--color-surface-3);
  }

  progress::-webkit-progress-bar { background: var(--color-surface-3); }
  progress::-webkit-progress-value { background: var(--color-accent); transition: width var(--dur-3); }
  progress::-moz-progress-bar { background: var(--color-accent); }

  @media (prefers-reduced-motion: reduce) { progress::-webkit-progress-value { transition: none; } }

  .meta {
    flex: none;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
    font-variant-numeric: tabular-nums;
  }

  .state { font-size: var(--text-xs); font-weight: 500; }
  /* Under review in the accent, as the goal bar's review; waiting on the user in the sidebar's "needs you". */
  .state.review { color: var(--color-accent); }
  .state.awaiting { color: var(--color-live); }
  .state.muted { color: var(--color-muted-foreground); }

  .checklist {
    padding-top: 4px;
    border-top: 1px solid var(--color-border);
  }

  .add {
    flex: none;
    align-self: flex-start;
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 6px;
    color: var(--color-muted-foreground);
  }

  .add-form { flex: none; margin-top: 6px; }

  .add-input {
    width: 100%;
    height: var(--input);
    font-size: var(--text-sm);
  }

  .pages {
    display: flex;
    justify-content: center;
    gap: 2px;
    flex: none;
    padding: 2px 0 6px;
  }

  /* A dot with a finger-sized target around it. */
  .page {
    width: 22px;
    height: 22px;
    padding: 0;
    display: grid;
    place-items: center;
    background: none;
    border: none;
  }

  .page::after {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-subtle);
    transition: background var(--dur-1), transform var(--dur-1) var(--ease-out-quint);
  }

  .page.on::after { background: var(--color-foreground); transform: scale(1.15); }
</style>
