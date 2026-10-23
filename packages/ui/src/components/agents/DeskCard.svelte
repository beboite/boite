<script lang="ts">
  import { CircleCheck, CircleX, GitMerge, GitPullRequest, GitPullRequestClosed, LoaderCircle, X } from '@lucide/svelte';
  import type { AgentWatch, Project } from '@boite/contracts';
  import { deskState, deskTone } from '../../lib/agent-desk';
  import { workedTime } from '../../lib/agent-turns';
  import { ago, exactTime } from '../../lib/format';
  import { fill, strings } from '../../lib/strings';

  /**
   * One thread on an agent's desk: its title, its project, one chip for how
   * it stands, its pull request with its checks, and when it last moved. A
   * thread that asks the user shows the question with its options, answered
   * here. The card opens its thread; the cross takes it off the desk.
   */
  let { watch, project, now, onopen, ondrop, onanswer }: {
    watch: AgentWatch;
    project: Project | null;
    now: number;
    onopen: () => void;
    /** Absent for a device that may not change the desk. */
    ondrop?: () => void;
    /** Absent for a device that may not answer. */
    onanswer?: (option: string) => Promise<void>;
  } = $props();
  const t = $derived(strings.agents.deskPanel);
  const standing = $derived(deskState(watch));
  const tone = $derived(deskTone(standing));
  const pr = $derived(watch.pullRequest);
  let answering = $state<string | null>(null);

  async function answer(option: string) {
    if (!onanswer || answering) return;
    answering = option;
    try { await onanswer(option); } finally { answering = null; }
  }
</script>

<article class="desk-card" data-state={standing} data-tone={tone} data-testid="desk-card" data-thread={watch.threadId}>
  <button type="button" class="desk-card-open" onclick={onopen} aria-label={fill(t.open, { title: watch.title })} title={fill(t.open, { title: watch.title })}></button>
  <header class="desk-card-head">
    {#key standing}<span class="desk-chip" data-tone={tone} data-testid="desk-chip"><span class="desk-chip-dot" aria-hidden="true"></span>{t.state[standing]}</span>{/key}
    <span class="desk-card-when" title={exactTime(watch.lastActivityAt)}>{ago(watch.lastActivityAt, now)}</span>
    {#if ondrop}
      <button type="button" class="ghost small icon desk-card-drop" aria-label={fill(t.drop, { title: watch.title })} title={fill(t.drop, { title: watch.title })} onclick={ondrop} data-testid="desk-card-drop"><X size={13} strokeWidth={1.75} /></button>
    {/if}
  </header>
  <strong class="desk-card-title">{watch.title}</strong>
  <p class="desk-card-meta">
    {#if project}<span class="desk-card-project">{project.name}</span>{/if}
    <span>{t.origin[watch.origin]}</span>
    {#if standing === 'stalled' && watch.stalledSince !== null}<span class="desk-card-silent">{fill(t.silent, { time: workedTime(now - watch.stalledSince) })}</span>{/if}
  </p>
  {#if pr}
    <p class="desk-card-pr" data-pr={pr.state} data-checks={pr.checks ?? 'none'} data-testid="desk-card-pr">
      <span class="desk-pr-badge">
        {#if pr.state === 'merged'}<GitMerge size={13} strokeWidth={1.75} />{:else if pr.state === 'closed'}<GitPullRequestClosed size={13} strokeWidth={1.75} />{:else}<GitPullRequest size={13} strokeWidth={1.75} />{/if}
        {fill(t.pr[pr.state], { number: String(pr.number) })}
      </span>
      {#if pr.checks}
        <span class="desk-pr-checks">
          {#if pr.checks === 'failing'}<CircleX size={13} strokeWidth={1.75} />{:else if pr.checks === 'passing'}<CircleCheck size={13} strokeWidth={1.75} />{:else}<LoaderCircle size={13} strokeWidth={1.75} class="spin" />{/if}
          {t.checks[pr.checks]}
        </span>
      {/if}
    </p>
  {/if}
  {#if watch.question}
    <div class="desk-question" data-testid="desk-question">
      <p>{watch.question.text}</p>
      {#if onanswer && watch.question.options.length}
        <div class="desk-options">
          {#each watch.question.options as option (option)}
            <button type="button" class="small" class:primary={answering === option} disabled={answering !== null} onclick={() => void answer(option)} data-testid="desk-answer">{option}</button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</article>
