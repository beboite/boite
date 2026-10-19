/**
 * The nightly's proof that its commit passed CI, instead of running CI again:
 * waits for the `ci` run that the push of this commit to main started, reruns
 * its failed jobs once, and fails unless it ends green. A main push tests what
 * changed since the last main commit whose CI passed (changes.ts), so a green
 * run means every suite passed on a tree no later change affected.
 *
 * A run cancelled on main has no verdict: main runs are only cancelled while
 * pending, when a newer push replaces them. With COMMIT_CI_FOLLOW=1 (the
 * nightly) the gate then moves to the newest main run that was not cancelled,
 * normally the push that replaced it, or with none newer to the newest older
 * main commit whose run passed, and writes the commit it passed as `sha` to
 * GITHUB_OUTPUT: the caller builds that commit, not GITHUB_SHA.
 *
 * Env: GITHUB_REPOSITORY, GITHUB_SHA, GH_TOKEN. COMMIT_CI_DRY_RUN=1 accepts the
 * pull request run of a branch commit and never reruns: the nightly's dry run.
 */
import { appendFileSync } from 'node:fs';

export type CiRun = {
  id: number; head_sha: string; head_branch: string; event: string;
  status: string; conclusion: string | null; run_attempt: number; html_url: string;
};
export type Options = { sha: string; dryRun: boolean; follow?: boolean };
/**
 * `sha` is the commit followed after a cancelled run, `retriedAttempt` the
 * attempt the gate reran; `elapsedMs` counts from the gate's start.
 */
export type State = { sha?: string; retriedAttempt?: number; elapsedMs: number };
export type Decision = { action: 'wait' | 'pass' | 'rerun' | 'follow' | 'fail'; run?: CiRun; message: string };

/** A dispatch right after a merge can start before GitHub creates the push's run. */
export const NO_RUN_GRACE_MS = 10 * 60_000;
/**
 * The longest CI job may take 35 minutes. A followed run may first wait that
 * long behind the main run ahead of it, then take as long, and a rerun again.
 */
export const DEADLINE_MS = 120 * 60_000;
const POLL_MS = 30_000;

const onMain = (run: CiRun) => run.event === 'push' && run.head_branch === 'main';
const cancelled = (run: CiRun) => run.status === 'completed' && run.conclusion === 'cancelled';

/** The main run that answers for a cancelled one: the newest newer run not cancelled, else the newest older green one. */
export function successor(runs: CiRun[], gone: CiRun): CiRun | undefined {
  const live = runs.filter((run) => onMain(run) && run.head_sha !== gone.head_sha && !cancelled(run)).sort((a, b) => b.id - a.id);
  return live.find((run) => run.id > gone.id)
    ?? live.find((run) => run.id < gone.id && run.status === 'completed' && run.conclusion === 'success');
}

export function decide(runs: CiRun[], { sha: started, dryRun, follow = false }: Options, state: State): Decision {
  const sha = state.sha ?? started;
  const candidates = runs.filter((run) => run.head_sha === sha && (dryRun || onMain(run)));
  const run = candidates.sort((a, b) => b.id - a.id)[0];
  const rule = `the nightly publishes only a commit whose CI${dryRun ? '' : ' on main'} passed`;
  if (!run) {
    return state.elapsedMs < NO_RUN_GRACE_MS
      ? { action: 'wait', message: `${sha} has no ci run yet` }
      : { action: 'fail', message: `${sha} has no ci run${dryRun ? '' : ' on main'} after ${NO_RUN_GRACE_MS / 60_000} minutes: ${rule}` };
  }
  if (run.status !== 'completed') return { action: 'wait', run, message: `${run.html_url} is ${run.status}` };
  if (state.retriedAttempt !== undefined && run.run_attempt <= state.retriedAttempt) {
    return { action: 'wait', run, message: `${run.html_url}: waiting for the rerun of attempt ${state.retriedAttempt} to start` };
  }
  if (run.conclusion === 'success') return { action: 'pass', run, message: `${run.html_url} passed (attempt ${run.run_attempt})` };
  if (run.conclusion === 'failure' && !dryRun && state.retriedAttempt === undefined) {
    return { action: 'rerun', run, message: `${run.html_url} failed (attempt ${run.run_attempt}); rerunning its failed jobs once` };
  }
  const next = follow && !dryRun && cancelled(run) ? successor(runs, run) : undefined;
  if (next) return { action: 'follow', run: next, message: `${run.html_url} was cancelled; following ${next.html_url} on ${next.head_sha}` };
  return { action: 'fail', run, message: `${run.html_url} ended ${run.conclusion ?? 'without a conclusion'} (attempt ${run.run_attempt}): ${rule}` };
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const { GITHUB_API_URL: base = 'https://api.github.com', GH_TOKEN: token } = process.env;
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} answered ${response.status}: ${await response.text()}`);
  return response;
}

if (import.meta.main) {
  const { GITHUB_REPOSITORY: repo, GITHUB_SHA: sha = '', GH_TOKEN: token } = process.env;
  if (!repo || !token || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('expected GITHUB_REPOSITORY, GH_TOKEN and a full GITHUB_SHA');
  const options = { sha, dryRun: process.env.COMMIT_CI_DRY_RUN === '1', follow: process.env.COMMIT_CI_FOLLOW === '1' };
  // Following needs the other main runs; a dry run never follows.
  const query = options.follow && !options.dryRun ? 'branch=main&event=push&per_page=50' : `head_sha=${sha}&per_page=20`;
  const started = Date.now();
  const state: State = { elapsedMs: 0 };
  let last = '';
  for (;;) {
    state.elapsedMs = Date.now() - started;
    let decision: Decision;
    try {
      const { workflow_runs: runs } = await (await api(`/repos/${repo}/actions/workflows/ci.yml/runs?${query}`)).json() as { workflow_runs: CiRun[] };
      decision = decide(runs, options, state);
    } catch (error) {
      // One unanswered poll is not a verdict on the commit.
      decision = { action: 'wait', message: `GitHub did not answer: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (decision.action === 'pass' || decision.action === 'fail') {
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${decision.message}\n`);
      if (decision.action === 'pass') {
        // The run that passed names the commit: the started one or the one followed.
        const passed = decision.run!.head_sha;
        if (!/^[a-f0-9]{40}$/.test(passed)) throw new Error(`${decision.run!.html_url} names no full commit SHA`);
        if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha=${passed}\n`);
      }
      console.log(decision.action === 'fail' ? `::error::${decision.message}` : decision.message);
      process.exit(decision.action === 'pass' ? 0 : 1);
    }
    if (decision.message !== last) console.log(decision.message);
    last = decision.message;
    if (decision.action === 'rerun') {
      await api(`/repos/${repo}/actions/runs/${decision.run!.id}/rerun-failed-jobs`, { method: 'POST' });
      state.retriedAttempt = decision.run!.run_attempt;
    }
    if (decision.action === 'follow') {
      state.sha = decision.run!.head_sha;
      state.retriedAttempt = undefined;
      continue;
    }
    if (Date.now() - started > DEADLINE_MS) {
      console.log(`::error::${state.sha ?? sha}: CI did not finish within ${DEADLINE_MS / 60_000} minutes (${decision.message})`);
      process.exit(1);
    }
    await Bun.sleep(POLL_MS);
  }
}
