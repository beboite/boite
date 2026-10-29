<script lang="ts">
  import { untrack } from 'svelte';
  import { CircleAlert, RefreshCw } from '@lucide/svelte';
  import { RpcErrorCode, type HomeCard, type HomeCardText, type HomeCardTone } from '@boite/contracts';
  import { RpcFailure } from '../lib/client';
  import { errorText } from '../lib/errors';
  import { count, exactTime, relativeTime } from '../lib/format';
  import { activeLocale } from '../lib/i18n.svelte';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';

  /**
   * The owner's status cards under the new-thread composer
   * (`docs/home-cards.md`). A script of theirs writes each card; this view
   * only reads them, and its one action runs the refresh the owner set up.
   * Nothing shows on a core without cards or too old to have them.
   */
  let { store, phone = false }: { store: Store; phone?: boolean } = $props();

  /** Rows a list shows before folding the rest into a count. */
  const SHOWN = 8;

  let cards = $state.raw<HomeCard[]>([]);
  let failure = $state('');
  let now = $state(Date.now());
  let revision = 0;

  async function load() {
    const client = store.client;
    if (!client) return;
    const current = ++revision;
    try {
      const next = await client.call('homeCards.list', {});
      if (current === revision) cards = next;
    } catch (cause) {
      // An older core has no cards to show: that is not a failure on the home screen.
      if (current === revision && !(cause instanceof RpcFailure && cause.code === RpcErrorCode.MethodNotFound)) cards = [];
    }
  }

  $effect(() => {
    const client = store.client;
    if (!client || store.connection !== 'ready') return;
    untrack(() => void load());
    const off = client.on('homeCards.updated', (next) => { ++revision; cards = next; });
    const clock = setInterval(() => (now = Date.now()), 30_000);
    return () => { off(); clearInterval(clock); ++revision; };
  });

  async function refresh(card: HomeCard) {
    const client = store.client;
    if (!client || card.refresh?.running) return;
    failure = '';
    try {
      const next = await client.call('homeCards.refresh', { id: card.id });
      cards = cards.map(entry => entry.id === next.id ? next : entry);
    } catch (cause) {
      failure = errorText(cause);
    }
  }

  /** The app's language when the card has it, English otherwise. */
  function say(text: HomeCardText): string {
    if (typeof text === 'string') return text;
    return text[activeLocale()] ?? text.en;
  }

  function value(entry: number | string): string {
    return typeof entry === 'number' ? count(entry) : entry;
  }

  /** No tone draws in the accent; `neutral` is the muted one. */
  function tone(entry: HomeCardTone | null): string {
    return entry ?? '';
  }

  /** Columns on a narrow card: two rows of even width, never four and two. */
  function narrow(stats: number): number {
    return stats <= 3 ? stats : stats === 4 ? 2 : 3;
  }

  function schedule(card: HomeCard): string {
    const every = card.refresh?.everyMinutes;
    return every ? fill(strings.homeCards.every, { minutes: String(every) }) : strings.homeCards.buttonOnly;
  }
</script>

{#if cards.length}
  <section class="home-cards" class:phone aria-label={strings.homeCards.region} data-testid="home-cards">
    {#each cards as card (card.id)}
      {@const content = card.content}
      {@const title = content ? say(content.title) : card.id}
      {@const taken = content?.updatedAt ?? card.changedAt}
      <article class="card" data-testid="home-card" data-card={card.id}>
        <header>
          <span class="dot {tone(content?.status?.tone ?? (card.error ? 'bad' : null))}" aria-hidden="true"></span>
          <h2>{title}</h2>
          {#if content?.note}<InfoTip text={say(content.note)} topic={fill(strings.homeCards.about, { title })} testid="home-card-note" lines />{/if}
          {#if content?.status}<span class="status {tone(content.status.tone)}">{say(content.status.text)}</span>{/if}
          <span class="meta">
            {#if card.refresh?.lastRun && !card.refresh.lastRun.ok}
              <InfoTip
                icon={CircleAlert}
                text={fill(strings.homeCards.failed, { reason: card.refresh.lastRun.message ?? '' })}
                topic={title}
                testid="home-card-failed"
              />
            {/if}
            <span class="age" title={taken ? [exactTime(taken), card.refresh ? schedule(card) : ''].filter(Boolean).join(' · ') : undefined} data-testid="home-card-age">
              {#if card.refresh?.running}{strings.homeCards.refreshing}{:else if taken}{fill(strings.homeCards.updated, { age: relativeTime(taken, now) })}{:else}{strings.homeCards.never}{/if}
            </span>
            {#if card.refresh}
              <button
                type="button"
                class="ghost icon refresh"
                class:running={card.refresh.running}
                aria-label={fill(strings.homeCards.refresh, { title })}
                title={schedule(card)}
                disabled={card.refresh.running}
                data-testid="home-card-refresh"
                onclick={() => void refresh(card)}
              ><RefreshCw size={14} strokeWidth={2} /></button>
            {/if}
          </span>
        </header>

        {#if content?.stats.length}
          <div class="stats" style:--columns={content.stats.length} style:--narrow={narrow(content.stats.length)}>
            {#each content.stats as stat, index (index)}
              <div class="stat {tone(stat.tone)}">
                {#key stat.value}<b>{value(stat.value)}</b>{/key}
                <span>{say(stat.label)}</span>
              </div>
            {/each}
          </div>
        {/if}

        {#each content?.lists ?? [] as list, index (index)}
          {#if list.items.length}
            <div class="list">
              <h3>{say(list.title)}<span class="count">{count(list.items.length)}</span></h3>
              <ul>
                {#each list.items.slice(0, SHOWN) as item, row (row)}
                  {@const label = say(item.label)}
                  <li class={tone(item.tone)}>
                    <span class="mark" aria-hidden="true"></span>{label}
                    {#if item.detail}<InfoTip text={say(item.detail)} topic={fill(strings.homeCards.details, { label })} testid="home-card-detail" lines />{/if}
                  </li>
                {/each}
                {#if list.items.length > SHOWN}<li class="more">{fill(strings.homeCards.more, { count: count(list.items.length - SHOWN) })}</li>{/if}
              </ul>
            </div>
          {/if}
        {/each}

        {#if card.error}
          <p class="error" data-testid="home-card-error">
            <CircleAlert size={13} strokeWidth={2} />
            <span><b>{fill(strings.homeCards.refused, { id: card.id })}</b> {card.error}</span>
          </p>
        {/if}
      </article>
    {/each}
    {#if failure}<p class="error" role="alert">{failure}</p>{/if}
  </section>
{/if}

<style>
  .home-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr));
    gap: 12px;
    width: 100%;
    max-width: var(--content);
    padding: 14px 20px 20px;
    text-align: left;
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .home-cards.phone { padding: 6px 0 0; }

  .card {
    --tone-ok: var(--color-success);
    --tone-warn: var(--color-live);
    --tone-bad: var(--color-danger);
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    padding: 12px 14px 14px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-xl);
    background:
      radial-gradient(120% 90% at 0% 0%, var(--color-accent-soft), transparent 55%),
      var(--color-surface);
    overflow: hidden;
    container: home-card / inline-size;
  }

  /* The accent runs along the top edge, the way a game panel is lit. */
  .card::before {
    content: '';
    position: absolute;
    inset: 0 0 auto;
    height: 2px;
    background: linear-gradient(90deg, var(--color-accent), transparent 70%);
    opacity: 0.8;
  }

  /* On a narrow card the age and the button go to their own line, never over the title. */
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 6px;
    min-width: 0;
  }

  h2 {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 650;
    letter-spacing: 0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }

  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-subtle);
  }

  .dot.ok { background: var(--tone-ok); box-shadow: 0 0 8px var(--tone-ok); }
  .dot.warn { background: var(--tone-warn); box-shadow: 0 0 8px var(--tone-warn); }
  .dot.bad { background: var(--tone-bad); box-shadow: 0 0 8px var(--tone-bad); }

  .status {
    flex: none;
    padding: 1px 8px;
    border-radius: var(--radius-full);
    background: var(--color-surface-3);
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .status.ok { color: var(--tone-ok); background: color-mix(in oklch, var(--tone-ok) 14%, transparent); }
  .status.warn { color: var(--tone-warn); background: color-mix(in oklch, var(--tone-warn) 14%, transparent); }
  .status.bad { color: var(--tone-bad); background: color-mix(in oklch, var(--tone-bad) 14%, transparent); }

  .age {
    flex: none;
    color: var(--color-subtle);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .refresh {
    width: 26px;
    height: 26px;
    margin: -4px -6px -4px 0;
    color: var(--color-muted-foreground);
  }

  .refresh.running :global(svg) { animation: spin 1s linear infinite var(--loops, running); }

  /* One row when the card is wide; a narrow one takes two even rows. */
  .stats {
    display: grid;
    grid-template-columns: repeat(var(--columns), minmax(0, 1fr));
    gap: 6px;
  }

  @container home-card (max-width: 620px) {
    .stats { grid-template-columns: repeat(var(--narrow), minmax(0, 1fr)); }
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: 8px 10px;
    border-radius: var(--radius-lg);
    background: var(--color-surface-2);
  }

  .stat b {
    font-size: var(--text-lg);
    line-height: 1.1;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--color-accent);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    animation: pop var(--dur-3) var(--ease-out-quint);
  }

  .stat.neutral b { color: var(--color-muted-foreground); }
  .stat.ok b { color: var(--tone-ok); }
  .stat.warn b { color: var(--tone-warn); }
  .stat.bad b { color: var(--tone-bad); }

  .stat span {
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .list h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 6px;
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .count {
    padding: 0 6px;
    border-radius: var(--radius-full);
    background: var(--color-accent-soft);
    color: var(--color-accent);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
  }

  ul {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    min-height: 26px;
    padding: 2px 4px 2px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-full);
    background: var(--color-surface-2);
    font-size: var(--text-sm);
  }

  li.more { padding-right: 10px; color: var(--color-subtle); }

  .mark {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-accent);
  }

  li.ok .mark { background: var(--tone-ok); }
  li.warn .mark { background: var(--tone-warn); }
  li.bad .mark { background: var(--tone-bad); }
  li.neutral .mark { background: var(--color-subtle); }

  /* A chip without an "i" keeps the same inner space on both sides. */
  li:not(:has(:global(.info-tip))) { padding-right: 10px; }

  .error {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 0;
    color: var(--color-danger);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }

  .error :global(svg) { flex: none; margin-top: 2px; }

  @media (prefers-reduced-motion: reduce) {
    .home-cards, .stat b, .refresh.running :global(svg) { animation: none; }
  }
</style>
