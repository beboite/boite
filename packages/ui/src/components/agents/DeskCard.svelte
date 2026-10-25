<script lang="ts">
  import { CircleCheck, CircleX, GitMerge, GitPullRequest, GitPullRequestClosed, LoaderCircle, X } from '@lucide/svelte';
  import type { AgentWatch, Project } from '@boite/contracts';
  import { deskState, deskTone } from '../../lib/agent-desk';
  import { workedTime } from '../../lib/agent-turns';
  import { ago, exactTime } from '../../lib/format';
  import { fill, strings } from '../../lib/strings';

  /**
   * One thread on an agent's desk, as a row: a status dot (breathing while
   * the thread works or waits on the user), its title, when it last moved,
   * and one meta line with how it stands, its project and its pull request
   * with its checks. A thread that asks the user opens its question under
   * the line with the options, answered here. The row opens its thread; the
   * cross, shown on hover and focus, takes it off the desk. A thread of
   * another machine of the group names that machine, says when it cannot be
   * reached, and opens only where this client reaches that machine.
   */
  let { watch, project, now, onopen, ondrop, onanswer }: {
    watch: AgentWatch;
    project: Project | null;
    now: number;
    /** Absent for a thread of a machine this client does not reach. */
    onopen?: () => void;
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

<article class="desk-row" data-state={standing} data-tone={tone} data-testid="desk-card" data-thread={watch.threadId}>
  {#if onopen}<button type="button" class="desk-card-open" onclick={onopen} aria-label={fill(t.open, { title: watch.title })} title={fill(t.open, { title: watch.title })}></button>{/if}
  <span class="desk-dot" data-tone={tone} title={t.origin[watch.origin]} aria-hidden="true"></span>
  <div class="desk-row-text">
    <div class="desk-row-head">
      <strong class="desk-card-title">{watch.title}</strong>
      <span class="desk-card-when" title={exactTime(watch.lastActivityAt)}>{ago(watch.lastActivityAt, now)}</span>
      {#if ondrop}
        <button type="button" class="ghost small icon desk-card-drop" aria-label={fill(t.drop, { title: watch.title })} title={fill(t.drop, { title: watch.title })} onclick={ondrop} data-testid="desk-card-drop"><X size={13} strokeWidth={1.75} /></button>
      {/if}
    </div>
    <p class="desk-card-meta">
      {#key standing}<span class="desk-chip" data-tone={tone} data-testid="desk-chip">{t.state[standing]}</span>{/key}
      {#if standing === 'stalled' && watch.stalledSince !== null}<span class="desk-card-silent">{fill(t.silent, { time: workedTime(now - watch.stalledSince) })}</span>{/if}
      {#if project}<span class="desk-card-project">{project.name}</span>{/if}
      {#if watch.machine}<span class="desk-card-machine" data-testid="desk-card-machine">{watch.machine}</span>{/if}
      {#if watch.unreachable}<span class="desk-card-unreachable" title={watch.unreachable} data-testid="desk-card-unreachable">{t.unreachable}</span>{/if}
      {#if pr}
        <span class="desk-card-pr" data-pr={pr.state} data-checks={pr.checks ?? 'none'} data-testid="desk-card-pr">
          <span class="desk-pr-badge">
            {#if pr.state === 'merged'}<GitMerge size={12} strokeWidth={1.75} />{:else if pr.state === 'closed'}<GitPullRequestClosed size={12} strokeWidth={1.75} />{:else}<GitPullRequest size={12} strokeWidth={1.75} />{/if}
            {fill(t.pr[pr.state], { number: String(pr.number) })}
          </span>
          {#if pr.checks}
            <span class="desk-pr-checks">
              {#if pr.checks === 'failing'}<CircleX size={12} strokeWidth={1.75} />{:else if pr.checks === 'passing'}<CircleCheck size={12} strokeWidth={1.75} />{:else}<LoaderCircle size={12} strokeWidth={1.75} class="spin" />{/if}
              {t.checks[pr.checks]}
            </span>
          {/if}
        </span>
      {/if}
    </p>
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
  </div>
</article>
