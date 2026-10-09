<!--
  The radar: the threads that have waited for the user a while (a permission,
  a question, an answer left unread), the longest first. A click opens one in
  Boite, the header opens the first; an answer is answered from here; Later
  hides the card for a while. It takes clicks (`data-hit`).
-->
<script lang="ts">
  import { CornerDownLeft, Hourglass } from '@lucide/svelte';
  import { relativeTime } from '../../lib/format';
  import { fill, strings } from '../../lib/strings';
  import { count } from '../../lib/companion/describe';
  import type { Radar } from '../../lib/companion/watch.svelte';
  import type { RadarEntry } from '../../lib/companion/watch';
  import CompanionReply from './CompanionReply.svelte';

  interface Props {
    radar: Radar;
    onopen: (threadId: string) => void;
    /** Sends the words to the thread; false when they did not go. */
    onreply: (threadId: string, text: string) => Promise<boolean>;
  }

  let { radar, onopen, onreply }: Props = $props();

  const copy = strings.companion.radar;
  /** Rows shown; the others are counted. */
  const ROWS = 4;
  let answering = $state<string | null>(null);
  let problem = $state('');

  const items = $derived(radar.items);
  const titleOf = (entry: RadarEntry) => entry.title || strings.companion.untitled;
  const metaOf = (entry: RadarEntry) => [entry.project, copy.kinds[entry.kind], relativeTime(entry.since, radar.now)].filter(Boolean).join(' · ');

  async function reply(threadId: string, text: string): Promise<boolean> {
    problem = '';
    try {
      if (!(await onreply(threadId, text))) return false;
      answering = null;
      return true;
    } catch (error) {
      problem = fill(strings.companion.failed, { reason: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  function answer(threadId: string | null) {
    answering = threadId;
    problem = '';
  }
</script>

<div class="card radar" data-hit role="status" data-testid="companion-radar">
  <header>
    <span class="mark" aria-hidden="true"><Hourglass size={14} /></span>
    <span class="heading">{count(items.length, copy.one, copy.many)}</span>
    <div class="actions">
      <button class="ghost small" title={copy.laterHint} onclick={() => radar.snooze()} data-testid="companion-radar-later">{copy.later}</button>
      <button class="primary small" onclick={() => onopen(items[0]!.threadId)} data-testid="companion-radar-first">{copy.openFirst}</button>
    </div>
  </header>
  <ul>
    {#each items.slice(0, ROWS) as entry (entry.threadId)}
      <li>
        <div class="entry">
          <button class="ghost row" title={copy.openHint} onclick={() => onopen(entry.threadId)}>
            <span class="title">{titleOf(entry)}</span>
            <span class="meta">{metaOf(entry)}</span>
          </button>
          {#if (entry.kind === 'answer' || entry.kind === 'failed') && answering !== entry.threadId}
            <button class="ghost icon" aria-label={strings.companion.reply.action} title={strings.companion.reply.action} onclick={() => answer(entry.threadId)} data-testid="companion-radar-reply"><CornerDownLeft size={13} /></button>
          {/if}
        </div>
        {#if answering === entry.threadId}
          <div class="answering">
            <CompanionReply title={titleOf(entry)} {problem} onsend={(text) => reply(entry.threadId, text)} oncancel={() => answer(null)} />
          </div>
        {/if}
      </li>
    {/each}
  </ul>
  {#if items.length > ROWS}<p class="more">{fill(copy.more, { count: String(items.length - ROWS) })}</p>{/if}
</div>

<style>
  .card {
    width: 380px;
    border: 1px solid var(--color-accent);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    box-shadow: var(--shadow-e2);
    animation: rise var(--dur-2) var(--ease-out-quint);
  }
  .radar {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 0 2px 6px;
  }
  .mark {
    flex: none;
    display: grid;
    color: var(--color-accent);
  }
  .heading {
    flex: 1;
    min-width: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }
  .actions {
    flex: none;
    display: flex;
    gap: 4px;
  }
  .small {
    height: var(--control-sm);
    padding: 0 10px;
    font-size: var(--text-xs);
  }
  ul {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .entry {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .row {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    height: auto;
    padding: 4px 6px;
    font-weight: 400;
    text-align: start;
  }
  .title,
  .meta {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title {
    font-size: var(--text-xs);
    font-weight: 600;
  }
  .meta {
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }
  .icon {
    flex: none;
    width: 24px;
    height: 24px;
  }
  .answering {
    padding: 2px 6px 6px;
  }
  .more {
    padding: 2px 6px;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .card {
      animation: none;
    }
  }
</style>
