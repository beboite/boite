/**
 * What a pull request watch reads on GitHub and how it decides that the
 * agent needs a look. Pure: the store (`pull-request-watch.ts`) runs `gh` and
 * keeps the state; everything here takes text in and gives values out.
 */

import { createHash } from 'node:crypto';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown, max = 500): string => typeof value === 'string' ? value.slice(0, max) : '';
const safeUrl = (value: unknown): string => {
  try { const url = new URL(String(value)); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
};

/** Pages of 100 read per list of remarks: 1,000 comments, the rest are not read. */
export const REMARK_PAGES = 10;
const LISTED = 10;
const SNIPPET = 200;

/**
 * One cheap GraphQL query (one point of GitHub's budget) whose answer moves
 * when anything a watch reports may have moved. `status` follows the state,
 * the draft flag, the mergeability, the merge state, the head, the checks and
 * the place in the merge queue; `remarks` follows comments,
 * reviews, their edits and the pull request's own update time.
 */
export const FINGERPRINT_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
state isDraft mergeable mergeStateStatus headRefOid updatedAt mergeQueueEntry{position}
comments(first:50,orderBy:{field:UPDATED_AT,direction:DESC}){totalCount nodes{lastEditedAt}}
reviews(last:50){totalCount nodes{lastEditedAt}}
reviewThreads{totalCount}
commits(last:1){nodes{commit{statusCheckRollup{state contexts{checkRunCountsByState{state count} statusContextCountsByState{state count}}}}}}
}}}`;

/** The detailed read, made only when the fingerprint moved: the checks one by one, with whether the base branch requires each. */
export const DETAIL_QUERY = `query($owner:String!,$name:String!,$number:Int!){viewer{login} repository(owner:$owner,name:$name){pullRequest(number:$number){
url state isDraft mergeable mergeStateStatus headRefOid headRefName headRepository{nameWithOwner} baseRefName mergeQueueEntry{position}
commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){totalCount nodes{__typename
... on CheckRun{name status conclusion detailsUrl startedAt completedAt isRequired(pullRequestNumber:$number) checkSuite{workflowRun{workflow{name}}}}
... on StatusContext{context state targetUrl createdAt isRequired(pullRequestNumber:$number)}
}}}}}}
}}}`;

export interface Fingerprint {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  status: string;
  remarks: string;
}

/** Who merged or closed the pull request, read once when it stops being open. */
export const CLOSER_QUERY = `query($owner:String!,$name:String!,$number:Int!){viewer{login} repository(owner:$owner,name:$name){pullRequest(number:$number){
state mergedBy{login} timelineItems(last:1,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{actor{login}}}}
}}}`;

/** The account that ended the pull request, empty when GitHub names none, and whether it is the agent's own. */
export function parseCloser(raw: string): { state: Fingerprint['state']; by: string; own: boolean } {
  const data = graphqlData(raw);
  const pr = pullRequestOf(data);
  const state = prState(pr.state);
  const by = state === 'MERGED' ? text(row(pr.mergedBy).login, 100) : text(row(row(list(row(pr.timelineItems).nodes)[0]).actor).login, 100);
  return { state, by, own: by !== '' && by.toLowerCase() === text(row(data.viewer).login, 100).toLowerCase() };
}

function graphqlData(raw: string): Row {
  if (raw.length > 4 * 1024 * 1024) throw new Error('GitHub answer exceeds 4 MB');
  const value = row(JSON.parse(raw));
  const errors = list(value.errors);
  if (errors.length) throw new Error(text(row(errors[0]).message) || 'GitHub answered with an error');
  return row(value.data);
}

function pullRequestOf(data: Row): Row {
  const pr = row(row(data.repository).pullRequest);
  if (!Object.keys(pr).length) throw new Error('GitHub has no such pull request');
  return pr;
}

function prState(value: unknown): Fingerprint['state'] {
  const state = String(value);
  if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') throw new Error(`GitHub gave the pull request state ${state}`);
  return state;
}

const counts = (value: unknown): string => list(value).map(row).filter(entry => Number(entry.count) > 0)
  .map(entry => `${text(entry.state)}:${Number(entry.count)}`).sort().join(',');
// An edit only moves `lastEditedAt` forward, so the newest stands for them all.
const newestEdit = (connection: Row): string => list(connection.nodes).map(row)
  .reduce((newest, node) => { const at = text(node.lastEditedAt); return at > newest ? at : newest; }, '');

export function parseFingerprint(raw: string): Fingerprint {
  const pr = pullRequestOf(graphqlData(raw));
  const contexts = row(row(row(row(list(row(pr.commits).nodes)[0]).commit).statusCheckRollup).contexts);
  const comments = row(pr.comments), reviews = row(pr.reviews);
  return {
    state: prState(pr.state),
    status: [pr.state, pr.isDraft, pr.mergeable, pr.mergeStateStatus, pr.headRefOid, queuePosition(pr), counts(contexts.checkRunCountsByState), counts(contexts.statusContextCountsByState)].map(String).join(' '),
    remarks: [comments.totalCount, newestEdit(comments), reviews.totalCount, newestEdit(reviews), row(pr.reviewThreads).totalCount, pr.updatedAt].map(String).join(' '),
  };
}

export type CheckStatus = 'pending' | 'passed' | 'failed';
export interface WatchCheck {
  name: string; status: CheckStatus; conclusion: string; required: boolean; url: string;
  /** Its name without its workflow: what the base branch's rules call it. */
  job: string;
  /** A commit status a service posted rather than a CI job: one may stay pending as long as it likes. */
  context: boolean;
  /** The workflow a CI job belongs to, its start and its end: empty for a commit status or what did not happen yet. */
  workflow: string; started: string; finished: string;
}
export interface WatchDetail {
  state: Fingerprint['state'];
  head: string;
  /** The head branch and its repository (`owner/name`): empty when GitHub does not say. */
  branch?: string;
  headRepository?: string;
  base: string;
  /** A draft cannot merge: a required context it never reports does not hold its verdict. */
  draft: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  /** Behind its base where the base requires branches up to date before merging (GitHub's BEHIND); null while GitHub computes. */
  behind: boolean | null;
  /** Its place in the merge queue, 1 next to merge; null out of it. Its checks run on the queue's merge group, not on the head. */
  queue: number | null;
  checks: WatchCheck[];
  /** The account `gh` signs in as: what it writes is the agent's own. */
  viewer: string;
}

function queuePosition(pr: Row): number | null {
  const entry = pr.mergeQueueEntry;
  if (!entry || typeof entry !== 'object') return null;
  const position = Number(row(entry).position);
  return Number.isInteger(position) && position > 0 ? position : 1;
}

const FAILED = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);

/**
 * The checks of the head commit, one per name. A check runs twice on one
 * commit when a workflow listens to both `push` and `pull_request`: a run
 * still going outranks every finished run of the same name, so the one that
 * finished first cannot report the check passed; otherwise the latest run wins.
 */
export function parseDetail(raw: string): WatchDetail {
  const data = graphqlData(raw);
  const pr = pullRequestOf(data);
  const commit = row(row(list(row(pr.commits).nodes)[0]).commit);
  const nodes = list(row(row(commit.statusCheckRollup).contexts).nodes).map(row);
  const runs = new Map<string, { check: WatchCheck; at: string }>();
  for (const node of nodes) {
    let name: string, job: string, status: CheckStatus, conclusion: string, url: string, at: string, workflow = '', started = '', finished = '';
    if (node.__typename === 'CheckRun') {
      workflow = text(row(row(row(node.checkSuite).workflowRun).workflow).name, 200);
      job = text(node.name, 200);
      name = workflow ? `${workflow} / ${job}` : job;
      const done = node.status === 'COMPLETED';
      conclusion = done ? text(node.conclusion, 50) : text(node.status, 50);
      status = !done ? 'pending' : FAILED.has(conclusion) ? 'failed' : 'passed';
      url = safeUrl(node.detailsUrl);
      at = done ? text(node.completedAt, 50) : '9999';
      started = text(node.startedAt, 50);
      finished = done ? text(node.completedAt, 50) : '';
    } else if (node.__typename === 'StatusContext') {
      name = job = text(node.context, 200);
      conclusion = text(node.state, 50);
      status = conclusion === 'PENDING' || conclusion === 'EXPECTED' ? 'pending' : FAILED.has(conclusion) ? 'failed' : 'passed';
      url = safeUrl(node.targetUrl);
      at = status === 'pending' ? '9999' : text(node.createdAt, 50);
    } else continue;
    if (!name) continue;
    const check: WatchCheck = { name, status, conclusion, required: node.isRequired === true, url, job, context: node.__typename === 'StatusContext', workflow, started, finished };
    const held = runs.get(name);
    if (!held || at > held.at) runs.set(name, { check: { ...check, required: check.required || held?.check.required === true }, at });
    else if (check.required) held.check.required = true;
  }
  const mergeable = String(pr.mergeable);
  const mergeState = typeof pr.mergeStateStatus === 'string' ? pr.mergeStateStatus : 'UNKNOWN';
  return {
    state: prState(pr.state),
    head: text(pr.headRefOid, 64) || text(commit.oid, 64),
    branch: text(pr.headRefName, 255),
    headRepository: text(row(pr.headRepository).nameWithOwner, 200),
    base: text(pr.baseRefName, 255),
    draft: pr.isDraft === true,
    mergeable: mergeable === 'MERGEABLE' || mergeable === 'CONFLICTING' ? mergeable : 'UNKNOWN',
    behind: mergeState === 'UNKNOWN' ? null : mergeState === 'BEHIND',
    queue: queuePosition(pr),
    checks: [...runs.values()].map(entry => entry.check),
    viewer: text(row(data.viewer).login, 100),
  };
}

export type RemarkKind = 'comment' | 'review' | 'review-comment';
export interface Remark {
  /** Unique across the three lists. */
  id: string;
  kind: RemarkKind;
  author: string;
  bot: boolean;
  body: string;
  url: string;
  createdAt: string;
  /** When a bot rewrote it; an edit by a person does not count as news. */
  editedAt: string | null;
  path: string | null;
  state: string | null;
  /** An inline comment that answers another in its thread. */
  reply?: boolean;
}

/** The REST pages of one kind of remark, newest pages read until a short one. */
export function remarkPath(kind: RemarkKind, repository: string, number: number, page: number): string {
  const list = kind === 'comment' ? `issues/${number}/comments` : kind === 'review' ? `pulls/${number}/reviews` : `pulls/${number}/comments`;
  return `repos/${repository}/${list}?per_page=100&page=${page}`;
}

/** One page of remarks; `full` says another page may follow. */
export function parseRemarks(kind: RemarkKind, raw: string): { remarks: Remark[]; full: boolean } {
  if (raw.length > 8 * 1024 * 1024) throw new Error('GitHub answer exceeds 8 MB');
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values)) throw new Error(`GitHub ${kind} list must be an array`);
  const remarks: Remark[] = [];
  for (const value of values) {
    const item = row(value), user = row(item.user);
    const id = item.id ?? item.node_id;
    if (id === undefined || id === null) continue;
    const login = text(user.login, 100);
    const bot = user.type === 'Bot' || login.endsWith('[bot]');
    const createdAt = text(item.submitted_at ?? item.created_at, 50);
    const updated = text(item.updated_at, 50);
    const state = kind === 'review' ? text(item.state, 50) : null;
    // A draft review is its author's alone, and an empty "commented" review only wraps its inline comments, read on their own.
    if (state === 'PENDING' || (state === 'COMMENTED' && !text(item.body).trim())) continue;
    if (!createdAt) continue;
    remarks.push({
      id: `${kind}:${String(id)}`, kind, author: login, bot, body: text(item.body, 4000), url: safeUrl(item.html_url),
      createdAt, editedAt: bot && updated && Date.parse(updated) > Date.parse(createdAt) ? updated : null,
      path: kind === 'review-comment' && item.path ? text(item.path, 500) : null, state,
      reply: kind === 'review-comment' && item.in_reply_to_id !== undefined && item.in_reply_to_id !== null,
    });
  }
  return { remarks, full: values.length >= 100 };
}

/** What the agent was last told about one pull request. */
export interface WatchMemory {
  head: string | null;
  /** The failures told on this head and still failing. */
  failed: string[];
  /** The checks that made "passed" when it was told; empty until it is, and again once one of them fails. */
  passed: string[];
  conflicting: boolean;
  /** Behind its base at the last clean answer. Absent from watches saved before it. */
  behind?: boolean;
  /** In the merge queue at the last read. Absent from watches saved before it. */
  queued?: boolean;
  remarksThrough: string;
  remarkIds: string[];
  /** `id#hash` of the newest body read for each remark, told or not, newest last. Absent from watches saved before it. */
  bodies?: string[];
}

export type WatchChange =
  | { kind: 'failed'; head: string; checks: Pick<WatchCheck, 'name' | 'conclusion' | 'url'>[] }
  | { kind: 'passed'; head: string; count: number; required: boolean }
  | { kind: 'remarks'; remarks: Pick<Remark, 'id' | 'author' | 'body' | 'url' | 'path' | 'state'>[] }
  | { kind: 'conflict'; base: string }
  /** The base requires the branch up to date and it fell behind: it cannot merge until it is updated. */
  | { kind: 'behind'; base: string }
  /** It left the merge queue still open: a check of its merge group failed, a conflict, or someone took it out. */
  | { kind: 'dequeued'; base: string }
  | { kind: 'closed'; state: 'MERGED' | 'CLOSED'; by: string };

export function initialMemory(since: number): WatchMemory {
  return { head: null, failed: [], passed: [], conflicting: false, remarksThrough: new Date(since).toISOString(), remarkIds: [], bodies: [] };
}

/** Remark bodies remembered per watch: past it, the oldest go and only the time cursor stands. */
const BODIES = 300;
/** A bot's comment saying it will not review now: a heading naming its quota, its rate limit or a skipped review. */
const NOTICE = /^[>\s]*#{1,6}\s*(?:review limit reached|rate limit (?:exceeded|reached)|usage limit reached|review skipped)\b|you(?:'|’)ve used all (?:the )?free/im;
/** The summary a review bot keeps rewriting in place: CodeRabbit's walkthrough, mtsu-patrol's summary. */
const SUMMARY_MARK = /<!--\s*(?:this is an auto-generated comment: summarize by coderabbit\.ai|mtsu-patrol:summary)\s*-->/i;

/** The findings a bot's review or summary says it posted, or null when it names no count. */
function findings(body: string): number | null {
  const posted = /actionable comments posted:\s*\**\s*(\d+)/i.exec(body);
  const outside = /outside diff range comments\s*\((\d+)\)/i.exec(body);
  if (posted || outside) return Number(posted?.[1] ?? 0) + Number(outside?.[1] ?? 0);
  if (/\*\*no comments posted\*\*/i.test(body)) return 0;
  if (/\*\*comments posted\*\*/i.test(body)) return 1;
  return null;
}

/** What an edit must change to be another remark: markup comments and spacing are not it. */
const bodyKey = (remark: Remark) => `${remark.id}#${createHash('sha256').update(remark.body.replaceAll(/<!--[\s\S]*?-->/g, ' ').replaceAll(/\s+/g, ' ').trim()).digest('hex').slice(0, 16)}`;

/** A bot answering the agent's reply in a thread by agreeing: CodeRabbit's "Thanks for the fix", "I withdraw this finding". */
const ACK = /^\s*`?@[\w-]+(?:\[bot\])?`?[,:]?\s+(?:thanks|thank you|verified|you(?:'|’)re right|i withdraw|understood|got it|confirmed)/i;
const CONCEDE = /\bi withdraw\b|\byou(?:'|’)re right\b/i;
/** Words that turn a thanks into a finding still open. A concession goes on to explain the code, so there only a turn against it counts. */
const DOUBT = /\b(?:however|but|still|not (?:yet|fully|quite)|missing|incomplete|instead|does(?:n't| not)|reopen\w*)\b/i;
const TURN = /\b(?:however|but|still|not (?:yet|fully|quite)|missing|incomplete|reopen\w*)\b/i;
/** What a bot reply says, without its markup, folded analysis, scripts and footer. */
const prose = (body: string) => body.replaceAll(/<!--[\s\S]*?-->/g, ' ').replaceAll(/<details>[\s\S]*?<\/details>/g, ' ').replaceAll(/```[\s\S]*?```/g, ' ').split(/\n---\n/)[0]!.trim();
const agrees = (body: string) => { const said = prose(body); return ACK.test(said) && !(CONCEDE.test(said) ? TURN : DOUBT).test(said); };

/**
 * Whether a remark someone else wrote asks something of the agent. A person's
 * always does; their edits never reach here. A bot's does when it is a new
 * comment, an inline thread or a reply in one, or a review or summary that
 * names findings; its rewrite of a remark does only when that is a summary
 * naming findings. A notice of a review it will not make never does, nor a
 * reply that only agrees with the agent's answer in a thread.
 */
export function actionable(remark: Remark, edited: boolean): boolean {
  if (!remark.bot) return true;
  if (remark.kind === 'comment' && NOTICE.test(remark.body)) return false;
  const count = findings(remark.body);
  if (remark.kind === 'review') return remark.state === 'CHANGES_REQUESTED' || (count === null ? remark.body.trim() !== '' : count > 0);
  if (edited || SUMMARY_MARK.test(remark.body)) return count !== null && count > 0;
  return !(remark.reply && agrees(remark.body));
}

/**
 * Compares what GitHub shows with what the agent was told. The first check
 * to fail on a head is told at once; failures after it wait for the head's CI
 * jobs to settle and go out as its verdict, unless an aggregate gate is all
 * that is new: a required job that started once the rest of its workflow
 * ended (CI required) says nothing new. "Passed" is told once per head,
 * when every check the base branch requires passed (every CI job where none is
 * required) and no CI job still runs; again when a new required check joins
 * that set, or after one of it failed. A remark counts when someone other than
 * the agent's own account wrote it, it asks something of the agent
 * (`actionable`) and its body was not read before. `remarks` null leaves
 * remarks for a later read.
 */
export function evaluate(memory: WatchMemory, detail: WatchDetail, remarks: Remark[] | null): { changes: WatchChange[]; next: WatchMemory } {
  const changes: WatchChange[] = [];
  const moved = detail.head !== memory.head;
  let failed = moved ? [] : memory.failed;
  let passed = moved ? [] : memory.passed;
  if (detail.checks.length > 0) {
    // Commit statuses count as CI only where no job runs: a review bot's may stay pending for good.
    const jobs = detail.checks.some(check => !check.context) ? detail.checks.filter(check => !check.context) : detail.checks;
    const running = jobs.some(check => check.status === 'pending');
    const failing = detail.checks.filter(check => check.status === 'failed');
    // A check that runs again leaves the list, so failing again is news again.
    failed = failed.filter(name => failing.some(check => check.name === name));
    const fresh = failing.filter(check => !failed.includes(check.name));
    // An aggregate gate (CI required) is a required job that started once every other job of its workflow ended.
    const aggregate = (check: WatchCheck) => check.required && !check.context && check.started !== ''
      && jobs.every(other => other === check || other.workflow !== check.workflow || (other.finished !== '' && other.finished <= check.started));
    if (fresh.length && (!failed.length || !running)) {
      if (!failed.length || !fresh.every(aggregate)) changes.push({ kind: 'failed', head: detail.head, checks: fresh.map(({ name, conclusion, url }) => ({ name, conclusion, url })) });
      failed = failing.map(check => check.name);
    }
    const required = detail.checks.filter(check => check.required);
    const gate = required.length ? required : jobs;
    const names = gate.map(check => check.name);
    const passedNow = !running && gate.every(check => check.status === 'passed');
    // A required check created and finished between two reads is never seen running.
    if (passedNow && (!passed.length || (required.length > 0 && names.some(name => !passed.includes(name))))) {
      changes.push({ kind: 'passed', head: detail.head, count: gate.length, required: required.length > 0 });
    }
    // A rerun that only runs keeps what was told; one that fails makes the next pass news.
    passed = passedNow ? names : gate.some(check => check.status === 'failed') ? [] : passed;
  }

  const through = Date.parse(memory.remarksThrough);
  const own = detail.viewer.toLowerCase();
  const activeAt = (remark: Remark) => Date.parse(remark.editedAt ?? remark.createdAt);
  const bodies = new Map((memory.bodies ?? []).map(entry => [entry.slice(0, entry.lastIndexOf('#')), entry]));
  // GitHub times are per second: remarks at the boundary are told apart by id.
  const read = (remarks ?? []).filter(remark => {
    const at = activeAt(remark);
    return Number.isFinite(at) && (at > through || (at === through && !memory.remarkIds.includes(remark.id))) && (remark.bot || remark.author.toLowerCase() !== own);
  }).sort((a, b) => activeAt(a) - activeAt(b));
  const fresh = read.filter(remark => {
    const key = bodyKey(remark), held = bodies.get(remark.id);
    bodies.delete(remark.id);
    bodies.set(remark.id, key);
    if (held === key) return false;
    const created = Date.parse(remark.createdAt);
    const edited = remark.editedAt !== null && (held !== undefined || created < through || (created === through && memory.remarkIds.includes(remark.id)));
    return actionable(remark, edited);
  });
  if (fresh.length) changes.push({ kind: 'remarks', remarks: fresh.map(({ id, author, body, url, path, state }) => ({ id, author, body, url, path, state })) });
  const latest = Math.max(through, ...read.map(activeAt));
  const atLatest = read.filter(remark => activeAt(remark) === latest).map(remark => remark.id);

  if (detail.mergeable === 'CONFLICTING' && !memory.conflicting) changes.push({ kind: 'conflict', base: detail.base });
  // UNKNOWN is GitHub still computing after a push; only a clean answer clears a conflict.
  const conflicting = detail.mergeable === 'UNKNOWN' ? memory.conflicting : detail.mergeable === 'CONFLICTING';
  // A merge ends the watch before this read; out of the queue and still open, it will not merge by itself.
  const queued = detail.queue !== null;
  if (memory.queued && !queued) changes.push({ kind: 'dequeued', base: detail.base });
  // The queue updates a queued branch itself; behind is told once, until a clean answer clears it.
  if (detail.behind === true && !memory.behind && !queued) changes.push({ kind: 'behind', base: detail.base });
  const behind = detail.behind === null ? memory.behind === true : detail.behind;
  return {
    changes,
    next: {
      head: detail.head, failed, passed, conflicting, behind, queued,
      remarksThrough: latest === through ? memory.remarksThrough : new Date(latest).toISOString(),
      remarkIds: latest === through ? [...memory.remarkIds, ...atLatest] : atLatest,
      bodies: [...bodies.values()].slice(-BODIES),
    },
  };
}

/**
 * Folds the changes of a later read into those still waiting to be told:
 * what a burst of activity brings over several reads goes out as one message.
 */
export function mergeChanges(held: WatchChange[], next: WatchChange[]): WatchChange[] {
  const out = structuredClone(held);
  for (const change of next) {
    const same = out.find(entry => entry.kind === change.kind);
    if (!same) { out.push(structuredClone(change)); continue; }
    if (same.kind === 'failed' && change.kind === 'failed') {
      if (same.head !== change.head) same.checks = [];
      same.head = change.head;
      for (const check of change.checks) if (!same.checks.some(entry => entry.name === check.name)) same.checks.push(check);
    } else if (same.kind === 'remarks' && change.kind === 'remarks') {
      for (const remark of change.remarks) {
        const index = same.remarks.findIndex(entry => entry.id === remark.id);
        if (index >= 0) same.remarks[index] = remark; else same.remarks.push(remark);
      }
    } else Object.assign(same, change);
  }
  // Checks that failed on an older head than the one that passed are no news, nor leaving the queue or falling behind once it merged.
  const passed = out.find(change => change.kind === 'passed');
  const closed = out.some(change => change.kind === 'closed');
  return out.filter(change => !(change.kind === 'failed' && passed && change.head !== passed.head) && !((change.kind === 'dequeued' || change.kind === 'behind') && closed));
}

/** Held changes a later read made untrue: falling behind, once the branch was updated or entered the merge queue. */
export function stillTrue(held: WatchChange[], memory: WatchMemory): WatchChange[] {
  return memory.behind && !memory.queued ? held : held.filter(change => change.kind !== 'behind');
}

function snippet(body: string): string {
  const flat = body.replaceAll(/<!--[\s\S]*?-->/g, ' ').replaceAll(/<details>[\s\S]*?<\/details>/g, ' ').replaceAll(/\s+/g, ' ').trim();
  return flat.length <= SNIPPET ? flat : `${flat.slice(0, SNIPPET - 3)}...`;
}

function listed<T>(items: T[], line: (item: T) => string): string[] {
  const lines = items.slice(0, LISTED).map(line);
  if (items.length > LISTED) lines.push(`  - and ${items.length - LISTED} more`);
  return lines;
}

function changeLines(change: WatchChange): string[] {
  switch (change.kind) {
    case 'failed':
      return [`- Checks failed on ${change.head.slice(0, 7)}:`, ...listed(change.checks, check => `  - ${check.name}${check.conclusion === 'FAILURE' ? '' : ` (${check.conclusion.toLowerCase()})`}${check.url ? ` ${check.url}` : ''}`)];
    case 'passed':
      return [`- All ${change.count} ${change.required ? 'required ' : ''}${change.count === 1 ? 'check' : 'checks'} passed on ${change.head.slice(0, 7)}.`];
    case 'remarks':
      return [`- ${change.remarks.length} new ${change.remarks.length === 1 ? 'comment or review' : 'comments or reviews'}:`, ...listed(change.remarks, remark => {
        const said = snippet(remark.body);
        return `  - ${remark.author || 'someone'}${remark.path ? ` on ${remark.path}` : ''}: ${said ? `"${said}"` : (remark.state ?? 'reviewed').toLowerCase().replaceAll('_', ' ')}${remark.url ? ` ${remark.url}` : ''}`;
      })];
    case 'conflict':
      return [`- The branch now conflicts with ${change.base}.`];
    case 'behind':
      return [`- The branch is behind ${change.base}, which requires it up to date before merging: merge ${change.base} into it if your task asks for the merge.`];
    case 'dequeued':
      return [`- It left the merge queue of ${change.base} without merging: read why on the pull request, fix it and queue it again if your task asks for the merge.`];
    case 'closed':
      return [`- ${change.by || 'Someone'} ${change.state === 'MERGED' ? 'merged' : 'closed'} the pull request; its watch ended.`];
  }
}

const SUMMARY: Record<WatchChange['kind'], string> = { failed: 'checks failed', passed: 'checks passed', remarks: 'new comments', conflict: 'merge conflict', behind: 'behind base', dequeued: 'left the merge queue', closed: 'closed' };

/** The message that wakes the agent, and the short line the conversation shows for it. */
export function wakeMessage(updates: { number: number; url: string; changes: WatchChange[] }[]): { text: string; label: string } {
  const sections = updates.map(update => [`Pull request #${update.number} (${update.url}):`, ...update.changes.flatMap(changeLines)].join('\n'));
  const text = [
    `Boite is watching ${updates.length === 1 ? 'this pull request' : 'these pull requests'} for you and ${updates.length === 1 ? 'it' : 'they'} changed.`,
    ...sections,
    '',
    'Look into each item and act on it as your task requires, then end your turn: Boite keeps watching and wakes you on the next change, so do not poll. `boite pr unwatch <url>` stops a watch.',
  ].join('\n');
  const label = updates.map(update => `#${update.number}: ${update.changes.map(change => change.kind === 'closed' ? change.state.toLowerCase() : SUMMARY[change.kind]).join(', ')}`).join('; ');
  return { text, label: `Pull request update, ${label}` };
}

/** gh's words for GitHub refusing because of its rate limit, primary or secondary. */
export function rateLimited(message: string): boolean {
  return /rate limit|abuse detection|HTTP 429|retry-after/i.test(message);
}
