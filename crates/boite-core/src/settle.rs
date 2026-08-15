//! Putting a thread away, and the one rule that keeps it from losing work.
//!
//! One gesture and its way back, held in `settled_at`: null is an ordinary live
//! thread, which is what every row written before the column existed reads as.
//!
//! `add_thread_ageing` also left `pin_order` and `snoozed_until` on `threads`,
//! and nothing reads them. They belonged to a pinned section and a wake clock
//! that shipped alongside settle and came back out with it: three mutually
//! exclusive states on one row, where the combinations were the bug. A migration
//! is a value once it has run, so the columns stay; the states do not come back.

/// The statuses that refuse to be put away.
///
/// `running` is a turn in flight. `waiting` is a dialog on screen with nothing
/// moving until the user answers it, which is the one status that must stay
/// where the user can see it. `ready` is not here on purpose: it is what a
/// finished agent sitting at its prompt reads as, and it is also what a plain
/// shell reads as, so refusing it would leave settle with nothing to act on.
const BUSY: &[&str] = &["running", "waiting"];

/// Whether a thread in this status may be put away.
///
/// The status is the caller's own live reading, because that is where it is
/// known: the desktop derives it in the window from the agent session files and
/// the emulator, and the row only ever records that there *was* a run.
pub fn can_settle(status: &str) -> bool {
    !BUSY.contains(&status)
}

/// Why a thread was refused, in a sentence the caller can show.
pub fn refusal(status: &str) -> String {
    format!(
        "this thread is {status}, so it stays where it can be seen: \
         a turn in flight or a dialog waiting for an answer is not finished business"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_working_or_waiting_thread_is_never_put_away() {
        assert!(!can_settle("running"), "a turn is in flight");
        assert!(!can_settle("waiting"), "a dialog is up and nothing moves");
        for ok in ["idle", "ready", "done", "exited", "error", "stopped"] {
            assert!(can_settle(ok), "{ok} is finished business");
        }
    }

    #[test]
    fn the_refusal_names_the_status_it_refused() {
        assert!(refusal("running").contains("running"));
        assert!(refusal("waiting").contains("waiting"));
    }
}
