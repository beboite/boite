<script lang="ts">
  // What a Claude thread's last request started with: the system blocks in
  // the order they were sent, the tools largest first, and the request's
  // parameters. Sizes are characters from the transcript; the token figure is
  // characters divided by four and says so.
  import { onMount, tick } from 'svelte';
  import { ChevronRight, X } from '@lucide/svelte';
  import type { AgentShape, ThreadId } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { Closing } from '../lib/closing.svelte';
  import { mobileOverlay } from '../lib/mobile-history';
  import { count, time } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';

  let { store, threadId, onclose }: { store: Store; threadId: ThreadId; onclose: () => void } = $props();

  const overlay = new Closing();
  let shape = $state<AgentShape | null>(null);
  let error = $state<string | null>(null);
  let dialog = $state<HTMLDivElement>();

  function portal(node: HTMLElement) {
    document.body.append(node);
    return { destroy: () => node.remove() };
  }

  onMount(() => {
    overlay.show();
    let current = true;
    void store.agentShape(threadId)
      .then(value => { if (current) shape = value; })
      .catch((failure: unknown) => { if (current) error = failure instanceof Error ? failure.message : String(failure); });
    void tick().then(() => dialog?.focus({ preventScroll: true }));
    return () => { current = false; };
  });

  $effect(() => { if (overlay.open) return mobileOverlay(close); });

  function close() { overlay.hide(); }
  // Gone from the DOM after its exit, by animation or by `Closing`'s own settle.
  let opened = false;
  $effect(() => { if (overlay.shown) opened = true; else if (opened) onclose(); });
  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !overlay.open) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  const n = (value: number) => count(value);
  const total = $derived(shape ? shape.chars.system + shape.chars.tools : 0);
  const share = (value: number) => `${total > 0 ? Math.max(0.5, value / total * 100) : 0}%`;
  const largest = $derived(shape?.tools[0]?.chars ?? 1);
  /** The figure in the mono face, the words around it in the language's order. */
  const estimate = $derived(strings.agentShape.estimate.split('{tokens}') as [string, string?]);
  const firstLine = (text: string) => text.split('\n').find(line => line.trim() !== '')?.trim() ?? '';
  const empty = $derived(!shape ? null : shape.status === 'no-session' ? strings.agentShape.noSession
    : shape.status === 'no-transcript' ? strings.agentShape.noTranscript
    : shape.status === 'unrecorded' ? strings.agentShape.unrecorded : null);
  const params = $derived(!shape ? [] : [
    [strings.agentShape.model, shape.model],
    [strings.agentShape.effort, shape.effort],
    [strings.agentShape.thinking, shape.thinking],
    [strings.agentShape.maxTokens, shape.maxTokens === null ? null : n(shape.maxTokens)],
    [strings.agentShape.version, shape.version],
    [strings.agentShape.sent, shape.at === null ? null : time(shape.at)],
  ].filter((entry): entry is [string, string] => entry[1] !== null));
</script>

<svelte:window onkeydowncapture={onkeydown} />

{#if overlay.shown}
  <div class="scrim" class:closing={overlay.closing} role="presentation" use:portal use:overlay.attach onanimationend={overlay.end}
    onclick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div class="dialog" class:closing={overlay.closing} role="dialog" aria-modal="true" aria-labelledby="agent-shape-title" tabindex="-1" data-testid="agent-shape" bind:this={dialog}>
      <div class="head">
        <div class="titles">
          <h2 id="agent-shape-title">{strings.agentShape.title}</h2>
          <p class="muted">{strings.agentShape.intro}</p>
        </div>
        <button type="button" class="ghost icon" aria-label={strings.common.close} data-testid="agent-shape-close" onclick={close}><X size={16} /></button>
      </div>
      <div class="body">
        {#if error}
          <p class="note" data-testid="agent-shape-error">{fill(strings.agentShape.failed, { error })}</p>
        {:else if !shape}
          <p class="note" data-testid="agent-shape-loading">{strings.agentShape.loading}</p>
        {:else if empty}
          <p class="note" data-testid="agent-shape-empty" data-status={shape.status}>{empty}</p>
        {:else}
          <section class="summary" data-testid="agent-shape-summary">
            <div class="estimate">
              <span class="big">{estimate[0]}<span class="mono">{n(shape.estimatedTokens)}</span>{estimate[1] ?? ''}</span>
              <InfoTip topic={strings.agentShape.estimate} text={strings.agentShape.estimateHint} />
            </div>
            <div class="bar" aria-hidden="true"><span class="system" style:width={share(shape.chars.system)}></span><span class="tools" style:width={share(shape.chars.tools)}></span></div>
            <dl class="legend">
              <div><dt><i class="system"></i>{strings.agentShape.system}</dt><dd class="mono">{n(shape.chars.system)}</dd></div>
              <div><dt><i class="tools"></i>{strings.agentShape.tools}</dt><dd class="mono">{n(shape.chars.tools)}</dd></div>
            </dl>
          </section>

          <section>
            <h3><span>{strings.agentShape.system}</span><span class="mono count">{shape.system.length + shape.omitted.system}</span></h3>
            <ol class="blocks">
              {#each shape.system as block, index (index)}
                <li>
                  <details data-testid="agent-shape-block">
                    <summary>
                      <ChevronRight size={14} class="caret" />
                      <span class="label">{fill(strings.agentShape.block, { n: String(index + 1) })}</span>
                      <span class="preview">{firstLine(block.text)}</span>
                      <span class="mono size">{n(block.chars)}</span>
                    </summary>
                    <pre class="mono">{block.text}</pre>
                    {#if block.truncated}<p class="note">{fill(strings.agentShape.truncated, { chars: n(block.chars) })}</p>{/if}
                  </details>
                </li>
              {/each}
            </ol>
            {#if shape.omitted.system > 0}<p class="note">{fill(strings.agentShape.omitted, { n: String(shape.omitted.system) })}</p>{/if}
          </section>

          <section>
            <h3><span>{strings.agentShape.tools}</span><span class="mono count">{shape.tools.length + shape.omitted.tools}</span></h3>
            <ul class="tools-list" data-testid="agent-shape-tools">
              {#each shape.tools as tool (tool.name)}
                <li data-testid="agent-shape-tool">
                  <span class="name mono" title={tool.name}>{tool.name}</span>
                  <span class="meter" aria-hidden="true"><span style:width={`${Math.max(2, tool.chars / largest * 100)}%`}></span></span>
                  <span class="mono size" title={fill(strings.agentShape.description, { chars: n(tool.descriptionChars) })}>{n(tool.chars)}</span>
                </li>
              {/each}
            </ul>
            {#if shape.omitted.tools > 0}<p class="note">{fill(strings.agentShape.omitted, { n: String(shape.omitted.tools) })}</p>{/if}
          </section>

          <section>
            <dl class="params" data-testid="agent-shape-params">
              {#each params as [label, value] (label)}<div><dt>{label}</dt><dd class="mono">{value}</dd></div>{/each}
              {#if shape.betas.length > 0}
                <div class="betas"><dt>{strings.agentShape.betas}</dt><dd>{#each shape.betas as beta (beta)}<span class="chip-beta mono" title={beta}>{beta}</span>{/each}</dd></div>
              {/if}
            </dl>
          </section>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim { position: fixed; inset: 0; z-index: 70; display: flex; align-items: flex-start; justify-content: center; padding-top: min(10vh, 90px);
    background: var(--color-scrim); animation: fade var(--dur-2) var(--ease-out-quint); }
  .scrim.closing { animation-name: fade-out; pointer-events: none; }
  .dialog { width: min(640px, calc(100vw - 32px)); max-height: min(80vh, 760px); display: flex; flex-direction: column;
    background: var(--color-surface); border: 1px solid var(--color-edge); border-radius: var(--radius-xl); box-shadow: var(--shadow-e3);
    overflow: hidden; animation: pop var(--dur-2) var(--ease-out-quint); color: var(--color-foreground); }
  .dialog.closing { animation-name: pop-out; }
  .dialog:focus { outline: none; }
  .head { display: flex; align-items: flex-start; gap: 12px; padding: 16px 14px 12px 18px; border-bottom: 1px solid var(--color-border); }
  .titles { flex: 1; min-width: 0; }
  h2 { font-size: var(--text-md); margin: 0 0 4px; }
  .muted { margin: 0; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 14px 18px 18px; }
  section + section { margin-top: 18px; }
  h3 { display: flex; justify-content: space-between; align-items: baseline; margin: 0 0 8px; font-size: var(--text-sm); font-weight: 600; }
  .count { font-weight: 400; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .note { margin: 8px 0 0; font-size: var(--text-xs); line-height: 1.5; color: var(--color-muted-foreground); }
  .estimate { display: flex; align-items: center; gap: 6px; }
  .big { font-size: var(--text-md); }
  .big .mono { font-size: inherit; font-weight: 600; }
  .bar { display: flex; height: 7px; margin: 10px 0 0; overflow: hidden; background: var(--color-border); border-radius: var(--radius-sm); }
  .bar .system, i.system { background: var(--color-accent); }
  .bar .tools, i.tools { background: var(--color-success); }
  dl { margin: 0; font-size: var(--text-xs); }
  dl div { display: flex; justify-content: space-between; gap: 16px; margin: 6px 0; }
  dt { display: flex; align-items: center; gap: 7px; color: var(--color-muted-foreground); }
  dd { margin: 0; min-width: 0; text-align: right; overflow-wrap: anywhere; }
  i { width: 7px; height: 7px; border-radius: var(--radius-sm); }
  .legend { margin-top: 10px; }
  ol, ul { list-style: none; margin: 0; padding: 0; }
  .blocks li + li, .tools-list li + li { margin-top: 2px; }
  summary { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 0 8px; border-radius: var(--radius-md); cursor: pointer; list-style: none; font-size: var(--text-sm); }
  summary::-webkit-details-marker { display: none; }
  summary:hover, summary:focus-visible { background: var(--color-hover); outline: none; }
  summary :global(.caret) { flex: none; color: var(--color-muted-foreground); transition: transform var(--dur-2) var(--ease-out-quint); }
  details[open] summary :global(.caret) { transform: rotate(90deg); }
  .label { flex: none; }
  .preview { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted-foreground); }
  .size { flex: none; font-size: var(--text-xs); color: var(--color-muted-foreground); font-variant-numeric: tabular-nums; }
  pre { margin: 6px 0 4px; padding: 10px 12px; max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--text-xs); line-height: 1.5;
    background: var(--color-code-background); color: var(--color-code-foreground); border-radius: var(--radius-md); }
  .tools-list li { display: grid; grid-template-columns: minmax(0, 11rem) 1fr 4.5rem; align-items: center; gap: 10px; min-height: 28px; padding: 0 8px; font-size: var(--text-xs); }
  .tools-list .size { text-align: right; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meter { height: 5px; background: var(--color-border); border-radius: var(--radius-sm); overflow: hidden; }
  .meter span { display: block; height: 100%; background: var(--color-success); border-radius: var(--radius-sm); }
  .params { padding-top: 12px; border-top: 1px solid var(--color-border); }
  .params .betas { display: block; }
  .betas dd { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; text-align: left; }
  .chip-beta { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1px 6px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); color: var(--color-muted-foreground); }
  @media (max-width: 720px) {
    .scrim { padding-top: 0; align-items: flex-end; }
    .dialog { width: 100%; max-height: calc(100dvh - 24px); border-radius: var(--radius-xl) var(--radius-xl) 0 0; border-bottom: none; }
    .head { padding: 14px 8px 10px 14px; }
    .head .icon { width: var(--touch-target); height: var(--touch-target); }
    .body { padding: 12px 14px calc(16px + env(safe-area-inset-bottom)); }
    summary { min-height: var(--touch-target); }
    .tools-list li { grid-template-columns: minmax(0, 1fr) 3.5rem 3.5rem; gap: 8px; }
  }
</style>
