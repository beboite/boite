//! Filing a thread away, and the one rule that keeps it from losing work.
//!
//! Three states, all of them nullable columns on `threads`, so a row written
//! before any of this existed reads back as an ordinary live thread and a Boite
//! older than the columns never selects them.
//!
//! - pinned: an explicit position in one workspace-wide order, held in
//!   `pin_order` so it reaches every device rather than the one that pinned it.
//! - settled: finished business, out of the main list until something touches it.
//! - snoozed: out of the way until a wake time, then back on its own.

/// The statuses that refuse to be filed away.
///
/// `running` is a turn in flight. `waiting` is a dialog on screen with nothing
/// moving until the user answers it, which is the one status that must stay
/// where the user can see it. `ready` is not here on purpose: it is what a
/// finished agent sitting at its prompt reads as, and it is also what a plain
/// shell reads as, so refusing it would leave settle with nothing to act on.
const BUSY: &[&str] = &["running", "waiting"];

/// Whether a thread in this status may be settled or snoozed.
///
/// The status is the caller's own live reading, because that is where it is
/// known: the desktop derives it in the window from the agent session files and
/// the emulator, and the row only ever records that there *was* a run. Pinning
/// asks nothing of this — a working thread is exactly the one worth pinning.
pub fn can_file_away(status: &str) -> bool {
    !BUSY.contains(&status)
}

/// Why a thread was refused, in a sentence the caller can show.
pub fn refusal(status: &str) -> String {
    format!(
        "this thread is {status}, so it stays where it can be seen: \
         a turn in flight or a dialog waiting for an answer is not finished business"
    )
}

/// A day in milliseconds, which is the unit auto-settle is set in.
pub const DAY_MS: i64 = 86_400_000;

/// Whether a quiet thread has been quiet long enough to file itself away.
///
/// `days` of zero is off, and off is the default: a thread nobody has touched
/// for a month is still one click from a relaunch, and a sidebar that empties
/// itself without being asked is the kind of surprise this feature is supposed
/// to avoid.
///
/// `last_activity` is when the thread last changed what it was doing, falling
/// back to when its row was created. A thread that is already filed away, or
/// pinned, or busy, is not a candidate.
pub fn due_for_auto_settle(
    status: &str,
    last_activity: i64,
    now: i64,
    days: i64,
) -> bool {
    if days <= 0 || !can_file_away(status) {
        return false;
    }
    now.saturating_sub(last_activity) >= days.saturating_mul(DAY_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_working_or_waiting_thread_is_never_filed_away() {
        assert!(!can_file_away("running"), "a turn is in flight");
        assert!(!can_file_away("waiting"), "a dialog is up and nothing moves");
        for ok in ["idle", "ready", "done", "exited", "error", "stopped"] {
            assert!(can_file_away(ok), "{ok} is finished business");
        }
    }

    /// The refusal outranks the clock. A thread that has printed nothing for a
    /// year but is sitting on a permission prompt is the exact row auto-settle
    /// must not take away.
    #[test]
    fn the_clock_cannot_settle_what_the_rule_refuses() {
        let year = 365 * DAY_MS;
        assert!(due_for_auto_settle("idle", 0, year, 7));
        assert!(!due_for_auto_settle("waiting", 0, year, 7));
        assert!(!due_for_auto_settle("running", 0, year, 7));
    }

    #[test]
    fn zero_days_is_off_and_the_boundary_is_inclusive() {
        assert!(!due_for_auto_settle("idle", 0, 999 * DAY_MS, 0));
        assert!(!due_for_auto_settle("idle", 0, 7 * DAY_MS - 1, 7));
        assert!(due_for_auto_settle("idle", 0, 7 * DAY_MS, 7));
    }
}
