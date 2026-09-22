<script lang="ts">
  import { Columns2, X } from '@lucide/svelte';
  import { tick, untrack } from 'svelte';
  import { Closing } from '../lib/closing.svelte';
  import { ProposalComparison as Comparison, proposalResponse, savedComparison } from '../lib/proposal-comparison.svelte';
  const text = strings.proposalComparison;
  import { strings } from '../lib/strings';
  import type { Choice, PickPatch, Store } from '../lib/store.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import Prose from './Prose.svelte';
  import StatusMark from './StatusMark.svelte';
  import DiffView from './DiffView.svelte';

  let { store }: { store: Store } = $props();
  const overlay = new Closing();
  let comparison = $state<Comparison | null>(null);
  let choices = $state<{ id: 'a' | 'b'; value: Choice | null }[]>([]);
  let prompt = $state('');
  let card = $state<HTMLDivElement>();
  let trigger = $state<HTMLButtonElement>();
  let submitted = $derived((comparison?.proposals.length ?? 0) > 0);
  let project = $derived(comparison?.project ?? store.openProject);

  function reset() {
    comparison = new Comparison(store);
    const first = store.defaultChoice();
    const secondProvider = store.providers.find(provider => provider.available && provider.id !== first?.providerId &&
      store.accountsOf(provider.id).some(account => account.status !== 'unauthenticated'));
    const account = secondProvider && store.accountsOf(secondProvider.id).find(account => account.status !== 'unauthenticated');
    const second = secondProvider && account ? {
      providerId: secondProvider.id, accountId: account.id, permissionMode: 'default' as const,
      model: store.defaultModelOf(secondProvider, account.id), effort: null
    } : first;
    choices = [{ id: 'a', value: first ? { ...first, permissionMode: 'default' } : null },
      { id: 'b', value: second ? { ...second, permissionMode: 'default' } : null }];
    prompt = '';
  }

  async function open() {
    const saved = store.openProject ? savedComparison(store, store.openProject.id) : null;
    if (saved) {
      comparison = saved;
      prompt = saved.prompt;
      choices = saved.proposals.map(proposal => ({ id: proposal.id, value: proposal.choice }));
    } else if (!comparison || !comparison.sameMachine || comparison.project?.id !== store.openProject?.id) reset();
    overlay.show();
    await tick();
    card?.querySelector<HTMLElement>('textarea, button')?.focus({ preventScroll: true });
  }

  function close() { overlay.hide(); trigger?.focus({ preventScroll: true }); }

  function pick(id: 'a' | 'b', patch: PickPatch) {
    const item = choices.find(choice => choice.id === id);
    if (!item?.value) return;
    const value = { ...item.value, ...patch };
    item.value = { ...value, effort: store.defaultEffortOf(value.providerId, value.accountId, value.model), speed: null };
  }

  async function launch() {
    if (!comparison || !project || !choices[0]?.value || !choices[1]?.value) return;
    await comparison.start(project, prompt, [choices[0].value, choices[1].value]);
  }

  function keyboard(event: KeyboardEvent) {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'Tab' || !card) return;
    const stops = [...card.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), [href]')];
    const first = stops[0], last = stops.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  // Read only while visible, with at most one pair of requests in flight.
  $effect(() => {
    if (!overlay.open || !comparison) return;
    const current = comparison;
    untrack(() => void current.refresh());
    const timer = window.setInterval(() => void current.refresh(), 2000);
    return () => window.clearInterval(timer);
  });
</script>

<button type="button" class="ghost icon" title={text.title} aria-label={text.title}
  data-testid="proposal-compare-open" bind:this={trigger} disabled={store.connection !== 'ready'} onclick={() => void open()}>
  <Columns2 size={16} strokeWidth={1.75} />
</button>

{#if overlay.shown && comparison}
  <div class="scrim" class:closing={overlay.closing} role="presentation" use:overlay.attach onanimationend={overlay.end}
    onclick={event => { if (event.target === event.currentTarget) close(); }}>
    <div class="comparison" class:closing={overlay.closing} role="dialog" aria-modal="true"
      aria-labelledby="proposal-title" tabindex="-1" bind:this={card} onkeydown={keyboard} data-testid="proposal-comparison">
      <header>
        <div><h2 id="proposal-title">{text.title}</h2><p class="muted">{project?.name}</p></div>
        <button type="button" class="ghost icon" title={text.close} aria-label={text.close} onclick={close}><X size={16} strokeWidth={1.75} /></button>
      </header>
      <div class="body">
        <p class="muted">{text.intro}</p>
        <label for="proposal-prompt">{text.prompt}</label>
        <textarea id="proposal-prompt" bind:value={prompt} disabled={submitted} placeholder={text.placeholder} rows="3" data-testid="proposal-prompt"></textarea>
        <div class="proposals">
          {#each choices as choice (choice.id)}
            {@const proposal = comparison.proposals.find(item => item.id === choice.id)}
            {@const response = proposalResponse(proposal?.snapshot ?? null)}
            <section class="proposal" data-testid="proposal-column" data-proposal={choice.id}>
              <div class="proposal-head"><h3>{choice.id === 'a' ? text.first : text.second}</h3>
                <span class="status">
                  {#if proposal?.phase === 'failed'}{text.failed}
                  {:else if proposal?.phase === 'starting'}{text.starting}
                  {:else if proposal?.thread}<StatusMark status={proposal.thread.status} />{strings.threadStatus[proposal.thread.status]}
                  {:else}{text.ready}{/if}
                </span>
              </div>
              <ModelPicker {store} choice={choice.value} disabled={submitted} onpick={patch => pick(choice.id, patch)} />
              {#if proposal?.thread?.branch}<p class="branch mono" title={proposal.thread.cwd}>{proposal.thread.branch}</p>{/if}
              {#if proposal?.error}<p class="error" role="alert">{proposal.error}</p>{/if}
              {#if proposal?.phase === 'failed' && proposal.thread}<p class="muted">{text.created}</p>{/if}
              {#if proposal?.readError}<p class="error" role="alert">{proposal.readError}</p>{/if}
              {#if proposal?.thread?.status === 'waiting'}<p class="notice">{text.waiting}</p>{/if}
              <div class="response" data-testid="proposal-response">
                {#if response}<Prose text={response} live={proposal?.thread?.status === 'running'} {store} threadId={proposal?.thread?.id} />
                {:else}<p class="muted">{submitted ? text.noText : text.empty}</p>{/if}
              </div>
              {#if proposal?.thread}
                <details class="changes" data-testid="proposal-changes">
                  <summary>{strings.rightPanel.changes}{proposal.changes ? ` · ${proposal.changes.changes.length}` : ''}</summary>
                  {#if proposal.changesError}<p class="error" role="alert">{proposal.changesError}</p>
                  {:else if !proposal.changes}<p class="muted">{strings.changes.loading}</p>
                  {:else if !proposal.changes.changes.length}<p class="muted">{strings.changes.clean}</p>
                  {:else}
                    <div class="change-list">
                      {#each proposal.changes.changes as change (change.path)}
                        <button type="button" class="ghost change" aria-pressed={proposal.selectedPath === change.path}
                          data-testid="proposal-change" data-path={change.path} onclick={() => void comparison?.selectDiff(choice.id, change.path)}>
                          <span class="mono">{change.path}</span><span class="muted">{strings.changes.status[change.status]}</span>
                        </button>
                      {/each}
                    </div>
                  {/if}
                  {#if proposal.diffError}<p class="error" role="alert">{proposal.diffError}</p>{/if}
                  {#if proposal.loadingDiff}<p class="muted">{strings.changes.loading}</p>
                  {:else if proposal.diff}
                    {#if proposal.diff.binary}<p class="muted">{strings.changes.binary}</p>
                    {:else}
                      {#if proposal.diff.truncated}<p class="notice">{strings.changes.truncated}</p>{/if}
                      <DiffView path={proposal.diff.path} oldText={proposal.diff.oldText ?? ''} newText={proposal.diff.newText ?? ''} />
                    {/if}
                  {/if}
                </details>
              {/if}
              {#if proposal?.thread}
                {@const threadId = proposal.thread.id}
                <button type="button" class="ghost continue" disabled={!comparison.sameMachine || !store.owner}
                  onclick={() => { close(); void store.open(threadId); }}>{text.continue}</button>
              {/if}
            </section>
          {/each}
        </div>
        {#if comparison.error}<p class="error" role="alert">{comparison.error}</p>{/if}
      </div>
      <footer>
        <p class="muted">{text.independent}</p>
        <div class="actions">
          {#if submitted}
            <button type="button" class="ghost" disabled={comparison.pending} onclick={() => void comparison?.refresh()}>{text.refresh}</button>
            <button type="button" disabled={comparison.pending} onclick={reset}>{text.newComparison}</button>
          {:else}
            <button type="button" class="primary" data-testid="proposal-launch"
              disabled={!prompt.trim() || !choices[0]?.value || !choices[1]?.value || !store.owner || store.connection !== 'ready'}
              onclick={() => void launch()}>{comparison.pending ? text.launching : text.launch}</button>
          {/if}
        </div>
      </footer>
    </div>
  </div>
{/if}

<style>
  .scrim { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 24px; background: var(--color-scrim); backdrop-filter: blur(4px); animation: fade var(--dur-2) var(--ease-out-quint); }
  .scrim.closing { animation-name: fade-out; pointer-events: none; }
  .comparison { width: min(1080px, 100%); max-height: calc(100dvh - 48px); display: flex; flex-direction: column; background: var(--color-surface); border: 1px solid var(--color-edge); border-radius: var(--radius-xl); box-shadow: var(--shadow-e3); overflow: hidden; animation: pop var(--dur-2) var(--ease-out-quint); }
  .comparison.closing { animation-name: pop-out; }
  header, footer { padding: 16px 20px; display: flex; gap: 16px; justify-content: space-between; align-items: center; flex: none; }
  header { border-bottom: 1px solid var(--color-border); }
  h2 { font-size: var(--text-md); }
  h3 { font-size: var(--text-base); }
  p, label { font-size: var(--text-sm); }
  .body { padding: 20px; overflow: auto; min-height: 0; }
  label { display: block; margin: 16px 0 6px; font-weight: 500; }
  textarea { width: 100%; min-height: calc(var(--input) * 2); resize: vertical; }
  .proposals { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 20px; }
  .proposal { min-width: 0; padding: 16px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-background); box-shadow: var(--shadow-e1); display: flex; flex-direction: column; align-items: start; gap: 12px; }
  .proposal-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; }
  .status { display: inline-flex; gap: 6px; align-items: center; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .branch { width: 100%; overflow-wrap: anywhere; color: var(--color-muted-foreground); }
  .response { min-height: 100px; width: 100%; overflow-wrap: anywhere; flex: 1; }
  .changes { width: 100%; border-top: 1px solid var(--color-border); padding-top: 10px; }
  .changes summary { cursor: pointer; font-size: var(--text-sm); }
  .changes p { margin-top: 8px; }
  .change-list { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; }
  .change { height: auto; min-height: var(--row); width: 100%; justify-content: space-between; text-align: left; white-space: normal; }
  .change .mono { overflow-wrap: anywhere; min-width: 0; }
  .change[aria-pressed=true] { background: var(--color-active); }
  .error { color: var(--color-danger); overflow-wrap: anywhere; }
  .notice { color: var(--color-live); }
  .continue { height: auto; min-height: var(--control); white-space: normal; }
  footer { border-top: 1px solid var(--color-border); align-items: flex-start; }
  footer p { max-width: 50%; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
  @media (max-width: 720px) {
    .scrim { padding: 8px; }
    .comparison { max-height: calc(100dvh - 16px); }
    header, footer, .body { padding: 14px; }
    .proposals { grid-template-columns: minmax(0, 1fr); gap: 12px; }
    .proposal { padding: 12px; }
    footer { flex-direction: column; gap: 12px; }
    footer p { max-width: none; }
    .actions { width: 100%; }
  }
</style>
