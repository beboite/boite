<script lang="ts">
  import { Globe, KeyRound } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import type { QuestionAnswer, SignInAsk } from '@boite/contracts';
  import { errorText } from '../lib/errors';
  import { keepFocus } from '../lib/focus';
  import { liveViews, machineName } from '../lib/live-view.svelte';
  import { rightPanel } from '../lib/right-panel.svelte';
  import { holdThread } from '../lib/thread-holds';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * A sign-in card an agent put in the conversation (`boite browser login`):
   * the sites it needs, and why. Open shows one in the conversation's browser,
   * in the panel and live, where the user signs in by hand; the card's
   * profile keeps it for every conversation of that machine. Signed in tells
   * the agent to go on. Nothing here sees a password.
   */
  let {
    store,
    threadId,
    questionId,
    text,
    signIn,
    answer,
    pending,
    docked = false,
    hostBrowser = false,
    respond,
    skip
  }: {
    store: Store;
    threadId: string;
    questionId: string;
    /** The agent's reason. */
    text: string;
    signIn: SignInAsk;
    answer: QuestionAnswer | null;
    /** False on a card that closed without an answer. */
    pending: boolean;
    /** Drawn inside the dock above the composer, whose own row names it: no frame, no heading. */
    docked?: boolean;
    /**
     * Drawn where no panel shows this thread (a persistent agent's
     * conversation, whose session thread nobody opens): Open shows the
     * browser in the card instead.
     */
    hostBrowser?: boolean;
    /** Answers the card with `done`. False gives it back. */
    respond: (optionId: 'done') => Promise<unknown>;
    skip: () => Promise<unknown>;
  } = $props();

  let busy = $state(false), opening = $state<number | null>(null), opened = $state(false), failure = $state('');
  const hosts = $derived(signIn.sites.map((site) => site.host).join(', '));
  // The panel's browser, loaded with the first Open of a card that hosts it.
  let surface = $state.raw<Promise<typeof import('./AgentBrowserSurface.svelte')> | null>(null);
  // Its browser streams only to a subscriber: the card holds the hidden thread's subscription while it shows it.
  let hold: { client: NonNullable<Store['client']>; release: () => void } | null = null, gone = false;
  onDestroy(() => { gone = true; hold?.release(); hold = null; });

  function path(url: string): string {
    // The query can hold a token: the card shows the path only, the title the whole address.
    try { const { pathname } = new URL(url); return pathname === '/' ? '' : pathname; } catch { return ''; }
  }

  /** The browser the user just asked for comes into view. */
  function reveal(node: HTMLElement): void {
    requestAnimationFrame(() => node.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }));
  }

  async function open(site: number): Promise<void> {
    const client = store.client;
    if (!client || opening !== null) return;
    opening = site; failure = '';
    try {
      if (hostBrowser && hold?.client !== client) {
        hold?.release();
        // Taken before the round trip, so a card that leaves meanwhile still lets it go.
        const taken = holdThread(client, threadId, () => store.openThread?.id === threadId);
        hold = { client, release: taken.release };
        // A refused subscription holds nothing: the next Open asks again.
        await taken.ready.catch((cause: unknown) => { taken.release(); if (hold?.release === taken.release) hold = null; throw cause; });
      }
      if (gone) return;
      await client.call('browser.signInOpen', { threadId, questionId, site });
      opened = true;
      // The user asked for this page: it shows live, without the cover.
      const key = store.threadKey(threadId);
      liveViews.show('agent-browser', key);
      if (hostBrowser) { surface ??= import('./AgentBrowserSurface.svelte'); return; }
      const panel = rightPanel.for(key);
      const tab = panel.surfaces.find((surface) => surface.kind === 'agent-browser');
      if (tab) panel.activate(tab.id); else panel.open('agent-browser');
    } catch (cause) { failure = errorText(cause); }
    finally { opening = null; }
  }

  async function finish(run: () => Promise<unknown>): Promise<void> {
    if (busy) return;
    busy = true;
    if ((await run()) === false) busy = false;
  }
</script>

<!-- An answer this client just sent clears the pending list before the card's answer arrives: it stays busy until then. -->
{#if answer !== null || (!pending && !busy)}
  <div class="sign-in-card resolved" data-testid="sign-in-card" data-state={answer === null ? 'closed' : 'answered'} title={text}>
    <span class="glyph"><KeyRound size={15} strokeWidth={1.75} /></span>
    <span class="verdict ui-label" data-testid="sign-in-verdict">{answer === null ? (pending ? strings.signInRequest.closed : strings.signInRequest.skipped) : strings.signInRequest.signedIn}</span>
    <span class="given ui-label">{hosts}</span>
  </div>
{:else}
  <div class="sign-in-card" class:docked data-testid="sign-in-card" data-state="pending" role="group" aria-label={strings.signInRequest.heading}>
    {#if !docked}
      <div class="head">
        <span class="glyph"><KeyRound size={15} strokeWidth={1.75} /></span>
        <span class="muted ui-label">{strings.signInRequest.heading}</span>
      </div>
    {/if}
    <p class="reason" data-testid="sign-in-reason">{text}</p>
    <ul class="sites">
      {#each signIn.sites as site, index (site.host)}
        <li class="site" data-testid="sign-in-site">
          <Globe size={14} strokeWidth={1.75} />
          <span class="where" title={site.url}><span class="host">{site.host}</span><span class="path">{path(site.url)}</span></span>
          <button type="button" class={opened ? 'ghost small' : 'primary small'} data-testid="sign-in-open" title={strings.signInRequest.openHint}
            disabled={opening !== null || busy} onmousedown={keepFocus} onclick={() => open(index)}><span class="ui-label">{strings.signInRequest.open}</span></button>
        </li>
      {/each}
    </ul>
    <p class="kept" data-testid="sign-in-kept">{fill(strings.signInRequest.kept, { profile: signIn.profileName, machine: machineName(store) })}</p>
    {#if failure}<p class="failure" role="alert">{failure}</p>{/if}
    <div class="actions">
      <button type="button" class={opened ? 'primary' : 'ghost'} data-testid="sign-in-done" disabled={busy} onmousedown={keepFocus} onclick={() => finish(() => respond('done'))}><span class="ui-label">{strings.signInRequest.done}</span></button>
      <button type="button" class="ghost" data-testid="sign-in-skip" disabled={busy} onmousedown={keepFocus} onclick={() => finish(skip)}><span class="ui-label">{strings.signInRequest.skip}</span></button>
    </div>
    {#if surface}
      <div class="browser" data-testid="sign-in-browser" {@attach reveal}>
        {#await surface then module}<module.default {store} {threadId} />{:catch cause}<p class="failure" role="alert">{errorText(cause)}</p>{/await}
      </div>
    {/if}
  </div>
{/if}

<style>
  .sign-in-card {
    border: 1px solid var(--color-edge);
    border-left-style: dashed;
    border-radius: var(--radius-md);
    background: var(--color-surface);
    box-shadow: var(--shadow-e1);
    padding: 8px 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .sign-in-card.docked {
    border: none;
    background: transparent;
    box-shadow: none;
    padding: 4px 10px 8px;
  }

  .head { display: flex; align-items: center; gap: 6px; }
  .glyph { display: inline-flex; flex: none; color: var(--color-accent); }
  .reason { margin: 0; font-weight: 500; white-space: pre-wrap; overflow-wrap: anywhere; }

  .sites { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
  .site {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 6px 6px 10px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    color: var(--color-subtle);
    font-size: var(--text-sm);
  }
  .where { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .host { color: var(--color-foreground); font-weight: 600; }
  .path { color: var(--color-muted-foreground); }
  .site button { flex: none; }

  .kept { margin: 0; font-size: var(--text-xs); color: var(--color-subtle); }
  /* The browser of an agent's conversation: tall enough to sign in, short enough that Signed in stays on a phone's screen. */
  .browser {
    display: flex;
    flex-direction: column;
    height: min(560px, 55dvh);
    min-height: 0;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .browser > :global(*) { flex: 1; min-height: 0; }
  .failure { margin: 0; font-size: var(--text-sm); color: var(--color-danger); overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; }

  /* Closed: one quiet row in the timeline, like an answered question. */
  .sign-in-card.resolved {
    flex-direction: row;
    align-items: center;
    gap: var(--activity-gap);
    border: none;
    background: transparent;
    box-shadow: none;
    min-height: var(--control);
    padding: var(--activity-padding);
    color: var(--color-muted-foreground);
  }
  .resolved .glyph { width: var(--activity-glyph); justify-content: center; color: var(--color-subtle); }
  .verdict { flex: none; font-size: var(--text-sm); }
  .given { min-width: 0; font-size: var(--text-sm); color: var(--color-foreground); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style>
