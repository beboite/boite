//! What a sync is doing right now, for whoever asks next.
//!
//! A fetch is seconds of network and the call that starts one answers in
//! milliseconds, so the work runs on a thread of its own and leaves a snapshot
//! here. The panel *reads snapshots* — on the desktop and on a phone talking to
//! a `boite-server`, through the same bus call, with no event channel written
//! twice and no progress lost because nobody was listening yet. A panel opened
//! half way through sees where it got to rather than an empty bar.
//!
//! One slot rather than a table of them: there is one mirror and one index, and
//! two syncs would race each other over both. A settled run stays in the slot on
//! purpose — the panel that asks after the last byte landed has to be able to
//! read "done" rather than "no such job", which is indistinguishable from "never
//! started".
//!
//! `NeedsMerge` is a phase and not a flag. It is settled, and it is not a
//! failure: files differ on both sides and the next thing that happens is a
//! person. Making it a phase means the polling loop stops there and the merge
//! tool opens off the same signal that ended the run.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;

use super::apply;
use super::plan::Divergence;
use super::scan;

/// How long a finished run is still worth answering about.
const KEEP_FINISHED_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Idle,
    /// Finding or making the mirror.
    Opening,
    Fetching,
    /// Reading this machine's side.
    Reading,
    Comparing,
    /// Putting the agreed side of each file where it goes.
    Writing,
    Committing,
    Pushing,
    Done,
    /// Settled, and not a failure. See the module header.
    NeedsMerge,
    Failed,
    Cancelled,
}

impl Phase {
    pub fn settled(self) -> bool {
        matches!(self, Phase::Idle | Phase::Done | Phase::NeedsMerge | Phase::Failed | Phase::Cancelled)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub phase: Phase,
    /// Whether this machine can sync at all — git has to be here.
    pub supported: bool,
    pub files_read: u64,
    /// `None` while the count is not known yet, which is a bar with no end
    /// rather than a number made up to fill one.
    pub files_total: Option<u64>,
    /// What is being worked on, for the line under the bar.
    pub path: Option<String>,
    /// Shown verbatim. When it came from git it is git's own sentence.
    pub message: Option<String>,
    pub pushed_sha: Option<String>,
    /// Unix ms of the last run that reached `Done`.
    pub last_synced_at: Option<i64>,
    /// Files still waiting on a person.
    pub pending: usize,
    pub started_at: i64,
    pub updated_at: i64,
    pub notes: scan::Notes,
    /// Placeholders this machine had no value to put back for.
    pub needed: Vec<super::portable::Applied>,
    pub refused: Vec<apply::Refused>,
    /// Where replaced contents were kept, when anything was replaced.
    pub backup_dir: Option<String>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Snapshot {
            phase: Phase::Idle,
            supported: true,
            files_read: 0,
            files_total: None,
            path: None,
            message: None,
            pushed_sha: None,
            last_synced_at: None,
            pending: 0,
            started_at: 0,
            updated_at: 0,
            notes: scan::Notes::default(),
            needed: Vec::new(),
            refused: Vec::new(),
            backup_dir: None,
        }
    }
}

struct State {
    snapshot: Snapshot,
    cancel: Arc<AtomicBool>,
    /// What the last comparison could not settle, still waiting on a person.
    conflicts: Vec<Divergence>,
    /// Paths a person has settled this round, either way.
    settled: BTreeSet<String>,
}

impl Default for State {
    fn default() -> Self {
        State {
            snapshot: Snapshot::default(),
            cancel: Arc::new(AtomicBool::new(false)),
            conflicts: Vec::new(),
            settled: BTreeSet::new(),
        }
    }
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}

/// Claims the slot, or says who has it.
///
/// The conflicts of a previous round are kept: a user who abandoned a merge and
/// comes back expects the same list, and a pull that cleared it would look like
/// the differences had resolved themselves.
pub fn start() -> Result<Arc<AtomicBool>, String> {
    let mut held = state().lock();
    if !held.snapshot.phase.settled() {
        return Err("a sync is already running".to_string());
    }
    let now = crate::now_ms();
    let last_synced_at = held.snapshot.last_synced_at;
    let cancel = Arc::new(AtomicBool::new(false));
    held.cancel = Arc::clone(&cancel);
    held.settled.clear();
    held.snapshot = Snapshot {
        phase: Phase::Opening,
        last_synced_at,
        started_at: now,
        updated_at: now,
        pending: held.conflicts.len(),
        ..Snapshot::default()
    };
    Ok(cancel)
}

pub fn phase(next: Phase) {
    let mut held = state().lock();
    held.snapshot.phase = next;
    held.snapshot.updated_at = crate::now_ms();
}

pub fn progress(read: u64, total: Option<u64>, path: Option<String>) {
    let mut held = state().lock();
    held.snapshot.files_read = read;
    held.snapshot.files_total = total;
    held.snapshot.path = path;
    held.snapshot.updated_at = crate::now_ms();
}

pub fn note_scan(notes: scan::Notes) {
    let mut held = state().lock();
    held.snapshot.notes = notes;
    held.snapshot.updated_at = crate::now_ms();
}

pub fn note_apply(outcome: &apply::Outcome) {
    let mut held = state().lock();
    held.snapshot.needed.extend(outcome.needed.iter().cloned());
    held.snapshot.refused.extend(outcome.refused.iter().cloned());
    if outcome.backup_dir.is_some() {
        held.snapshot.backup_dir.clone_from(&outcome.backup_dir);
    }
    held.snapshot.updated_at = crate::now_ms();
}

/// Replaces what is waiting on a person.
pub fn set_conflicts(conflicts: Vec<Divergence>) {
    let mut held = state().lock();
    held.snapshot.pending = conflicts.len();
    held.conflicts = conflicts;
    held.snapshot.updated_at = crate::now_ms();
}

pub fn conflicts() -> Vec<Divergence> {
    state().lock().conflicts.clone()
}

/// The paths a person has settled and that have not been sent yet.
///
/// They travel as this machine has them, whatever the base says, or a merged
/// file would come back as a conflict on every run — which is the one thing the
/// merging was supposed to end.
pub fn settled() -> BTreeSet<String> {
    state().lock().settled.clone()
}

/// Forgets them, once they are somewhere the next run will read them from.
pub fn forget_settled() {
    state().lock().settled.clear();
}

/// One file the user decided about, either by merging it or by leaving it.
///
/// Removing it from the list is what makes an abandoned merge safe to come back
/// to: whatever is still there is still waiting, and whatever left was written.
pub fn settle_one(path: &str, keep_waiting: bool) -> bool {
    let mut held = state().lock();
    let Some(index) = held.conflicts.iter().position(|item| item.path == path) else {
        return false;
    };
    if !keep_waiting {
        held.conflicts.remove(index);
    }
    held.settled.insert(path.to_string());
    held.snapshot.pending = held.conflicts.len();
    held.snapshot.updated_at = crate::now_ms();
    true
}

/// Whether a path is one this round is waiting on.
///
/// The gate on writing arbitrary bytes: a merge result is only accepted for a
/// file the comparison actually put in front of the user. Free-form it would be
/// a write-anywhere primitive reachable from a webview.
pub fn is_waiting(path: &str) -> bool {
    state().lock().conflicts.iter().any(|item| item.path == path)
}

pub fn finish(phase: Phase, message: Option<String>, pushed: Option<String>) {
    let mut held = state().lock();
    let now = crate::now_ms();
    held.snapshot.phase = phase;
    held.snapshot.message = message;
    held.snapshot.pushed_sha = pushed;
    held.snapshot.path = None;
    held.snapshot.updated_at = now;
    if phase == Phase::Done {
        held.snapshot.last_synced_at = Some(now);
    }
}

pub fn cancel() -> bool {
    let held = state().lock();
    if held.snapshot.phase.settled() {
        return false;
    }
    held.cancel.store(true, Ordering::SeqCst);
    true
}

pub fn cancelled(flag: &AtomicBool) -> bool {
    flag.load(Ordering::SeqCst)
}

/// Forgets a settled run, which is how a failure is dismissed.
pub fn dismiss() {
    let mut held = state().lock();
    if !held.snapshot.phase.settled() {
        return;
    }
    let last_synced_at = held.snapshot.last_synced_at;
    let pending = held.conflicts.len();
    held.snapshot = Snapshot { phase: Phase::Idle, last_synced_at, pending, ..Snapshot::default() };
}

/// The snapshot, with a run nobody asked about in ten minutes aged back to idle.
pub fn snapshot() -> Snapshot {
    let mut held = state().lock();
    let stale = held.snapshot.phase.settled()
        && held.snapshot.phase != Phase::Idle
        && crate::now_ms() - held.snapshot.updated_at > KEEP_FINISHED_MS;
    if stale {
        let last_synced_at = held.snapshot.last_synced_at;
        let pending = held.conflicts.len();
        held.snapshot =
            Snapshot { phase: Phase::Idle, last_synced_at, pending, ..Snapshot::default() };
    }
    held.snapshot.clone()
}

/// Only for tests: puts the slot back the way a fresh process finds it.
#[cfg(test)]
pub(super) fn forget_everything() {
    *state().lock() = State::default();
}

/// Only for tests: one slot means one test at a time.
///
/// The slot is process-wide by design, so tests that use it have to queue rather
/// than interleave. Held for the length of a test, and it clears the slot on the
/// way in so no test inherits another's run.
#[cfg(test)]
pub(super) fn exclusive() -> parking_lot::MutexGuard<'static, ()> {
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    let guard = GATE.get_or_init(|| Mutex::new(())).lock();
    forget_everything();
    guard
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_sync_at_a_time_and_a_settled_one_stands_aside() {
        let _alone = exclusive();
        let _first = start().expect("the slot was free");
        assert!(start().is_err(), "two syncs claimed the same mirror");
        finish(Phase::Done, None, None);
        assert!(start().is_ok(), "a settled run kept the slot");
    }

    /// Settled, and not a failure. A panel must be able to tell "it stopped
    /// because it broke" from "it stopped because it is your turn".
    #[test]
    fn needs_merge_is_settled_and_is_not_a_failure() {
        let _alone = exclusive();
        assert!(Phase::NeedsMerge.settled());
        assert_ne!(Phase::NeedsMerge, Phase::Failed);
        let _ = start().expect("free");
        finish(Phase::NeedsMerge, None, None);
        assert_eq!(snapshot().phase, Phase::NeedsMerge);
        // And it is not a sync that succeeded, so nothing claims a fresh time.
        assert!(snapshot().last_synced_at.is_none());
    }

    /// "It stopped at 40 of 60" and "it stopped" are different things to read.
    #[test]
    fn a_failure_keeps_what_it_had_got_to() {
        let _alone = exclusive();
        let _ = start().expect("free");
        progress(40, Some(60), Some("agents/.agents/AGENTS.md".into()));
        finish(Phase::Failed, Some("git said no".into()), None);
        let out = snapshot();
        assert_eq!(out.files_read, 40);
        assert_eq!(out.files_total, Some(60));
        assert_eq!(out.message.as_deref(), Some("git said no"));
    }

    /// A merge abandoned half way comes back to the same list, and a pull that
    /// cleared it would look like the differences had settled themselves.
    #[test]
    fn what_is_waiting_survives_the_next_run() {
        let _alone = exclusive();
        let _ = start().expect("free");
        set_conflicts(vec![divergence("agents/.agents/AGENTS.md")]);
        finish(Phase::NeedsMerge, None, None);
        assert_eq!(snapshot().pending, 1);

        let _ = start().expect("free");
        assert_eq!(snapshot().pending, 1, "the waiting list was cleared by a new run");
        assert_eq!(conflicts().len(), 1);
    }

    /// The gate on writing arbitrary bytes: only a file the comparison put in
    /// front of the user can be settled with them.
    #[test]
    fn only_a_waiting_file_can_be_settled() {
        let _alone = exclusive();
        let _ = start().expect("free");
        set_conflicts(vec![divergence("agents/.agents/AGENTS.md")]);
        assert!(is_waiting("agents/.agents/AGENTS.md"));
        assert!(!is_waiting("claude/.claude/settings.json"));
        assert!(!settle_one("claude/.claude/settings.json", false));

        assert!(settle_one("agents/.agents/AGENTS.md", false));
        assert!(!is_waiting("agents/.agents/AGENTS.md"));
        assert_eq!(snapshot().pending, 0);
    }

    /// Leaving a file alone keeps it waiting, so the next comparison asks again.
    #[test]
    fn a_file_left_alone_stays_waiting() {
        let _alone = exclusive();
        let _ = start().expect("free");
        set_conflicts(vec![divergence("agents/.agents/AGENTS.md")]);
        assert!(settle_one("agents/.agents/AGENTS.md", true));
        assert!(is_waiting("agents/.agents/AGENTS.md"));
        assert_eq!(snapshot().pending, 1);
    }

    /// Dismissing a failure clears the run and nothing else. What is still
    /// waiting on a person is not a failure to dismiss.
    #[test]
    fn dismissing_a_failure_leaves_the_waiting_list_alone() {
        let _alone = exclusive();
        let _ = start().expect("free");
        set_conflicts(vec![divergence("agents/.agents/AGENTS.md")]);
        finish(Phase::Failed, Some("git said no".into()), None);
        dismiss();
        let out = snapshot();
        assert_eq!(out.phase, Phase::Idle);
        assert!(out.message.is_none());
        assert_eq!(out.pending, 1);
    }

    /// A running job is not dismissed out from under itself.
    #[test]
    fn a_running_job_is_not_dismissed() {
        let _alone = exclusive();
        let _ = start().expect("free");
        phase(Phase::Fetching);
        dismiss();
        assert_eq!(snapshot().phase, Phase::Fetching);
    }

    #[test]
    fn cancelling_raises_the_flag_the_worker_watches() {
        let _alone = exclusive();
        let flag = start().expect("free");
        assert!(!cancelled(&flag));
        assert!(cancel());
        assert!(cancelled(&flag));
        finish(Phase::Cancelled, None, None);
        assert!(!cancel(), "a settled run was cancelled again");
    }

    fn divergence(path: &str) -> Divergence {
        Divergence {
            path: path.to_string(),
            source_id: "agents".to_string(),
            syntax: "markdown".to_string(),
            base: None,
            local: Some("# mine\n".to_string()),
            remote: Some("# theirs\n".to_string()),
            binary: false,
        }
    }
}
