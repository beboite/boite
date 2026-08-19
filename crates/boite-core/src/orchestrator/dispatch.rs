//! Whether a queued dispatch may be typed into its target, decided from facts.
//!
//! Pure like [`super::wake`]: the device that owns the target PTY gathers what
//! it knows about the target and this module answers with one of three words.
//! `boite_core::reply` forbids typing bytes from the bus on purpose, so the
//! only thing that ever types a dispatch is a device, and the only policy that
//! device applies is this table — one implementation, or the desktop and the
//! headless server drift on when a line is allowed to land.
//!
//! The guards, in the order they are applied, each refusal named:
//!
//! 1. TTL first: a line queued for an hour answers a context nobody remembers.
//!    It settles `dropped` with reason `no_device` whatever else is true.
//! 2. A target waiting on a permission or a dialog is never typed into —
//!    `WAITING_ON_USER`. A dispatch landing in a permission prompt would
//!    answer the question in the orchestrator's voice.
//! 3. A target carrying a role is another orchestrator —
//!    `NO_ORCHESTRATOR_TO_ORCHESTRATOR`, in both directions, always.
//! 4. A target the user muted stays muted — `MUTED`. Only the user's own
//!    window rearms `accept_dispatch`.
//! 5. A project orchestrator owns dispatch into its project — `SCOPE_TAKEN`
//!    for anyone else's line.
//! 6. Only then the phase: a target not at its prompt (`ready` or `idle`)
//!    holds a `queue` dispatch for the next look, and refuses a `now` one as
//!    `TARGET_BUSY` — "now" that arrives later is not what was asked.

/// What the device knows about the target at the moment of the flush.
#[derive(Debug, Clone)]
pub struct Target {
    /// The phase the device's own engine reports: `ready`, `idle`, `running`,
    /// anything else it names.
    pub phase: String,
    /// A permission request or a dialog is on screen for this thread.
    pub waiting_on_user: bool,
    /// The target's `role` column. Any role at all refuses the flush.
    pub role: Option<String>,
    /// The target's `accept_dispatch` column.
    pub accept_dispatch: bool,
    /// A live project orchestrator owns the target's project, and this
    /// dispatch is not from it.
    pub scope_taken: bool,
}

/// How the orchestrator asked for the line to land.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Wait for the target's prompt.
    Queue,
    /// At the prompt right now or not at all.
    Now,
}

impl Mode {
    /// The wire word, `queue` unless it is exactly `now`. An unknown word
    /// queuing rather than typing is the failure direction that costs nothing.
    pub fn parse(word: &str) -> Mode {
        if word == "now" {
            Mode::Now
        } else {
            Mode::Queue
        }
    }
}

/// The answer, one of three: type it, keep it queued, or settle it refused
/// with the named reason and the state to write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Type the line, then settle `delivered`.
    Type,
    /// Leave the row queued; the next phase change looks again.
    Hold,
    /// Settle the row with this state and reason, and stop.
    Settle {
        state: &'static str,
        reason: &'static str,
    },
}

/// The refusal states a settle may write. The device reports one of these
/// three words back through `dispatch.settle`, nothing else.
pub const STATE_DELIVERED: &str = "delivered";
pub const STATE_DROPPED: &str = "dropped";
pub const STATE_REFUSED: &str = "refused";

pub fn flush(target: &Target, mode: Mode, expired: bool) -> Decision {
    if expired {
        return Decision::Settle {
            state: STATE_DROPPED,
            reason: "no_device",
        };
    }
    if target.waiting_on_user {
        return Decision::Settle {
            state: STATE_REFUSED,
            reason: "WAITING_ON_USER",
        };
    }
    if target.role.is_some() {
        return Decision::Settle {
            state: STATE_REFUSED,
            reason: "NO_ORCHESTRATOR_TO_ORCHESTRATOR",
        };
    }
    if !target.accept_dispatch {
        return Decision::Settle {
            state: STATE_REFUSED,
            reason: "MUTED",
        };
    }
    if target.scope_taken {
        return Decision::Settle {
            state: STATE_REFUSED,
            reason: "SCOPE_TAKEN",
        };
    }
    if target.phase != "ready" && target.phase != "idle" {
        return match mode {
            Mode::Queue => Decision::Hold,
            Mode::Now => Decision::Settle {
                state: STATE_REFUSED,
                reason: "TARGET_BUSY",
            },
        };
    }
    Decision::Type
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> Target {
        Target {
            phase: "ready".into(),
            waiting_on_user: false,
            role: None,
            accept_dispatch: true,
            scope_taken: false,
        }
    }

    #[test]
    fn a_ready_quiet_target_takes_the_line() {
        assert_eq!(flush(&ready(), Mode::Queue, false), Decision::Type);
        assert_eq!(flush(&ready(), Mode::Now, false), Decision::Type);
        let idle = Target {
            phase: "idle".into(),
            ..ready()
        };
        assert_eq!(flush(&idle, Mode::Queue, false), Decision::Type);
    }

    #[test]
    fn a_busy_target_holds_queue_and_refuses_now_by_name() {
        let busy = Target {
            phase: "running".into(),
            ..ready()
        };
        assert_eq!(flush(&busy, Mode::Queue, false), Decision::Hold);
        assert_eq!(
            flush(&busy, Mode::Now, false),
            Decision::Settle {
                state: STATE_REFUSED,
                reason: "TARGET_BUSY"
            }
        );
    }

    #[test]
    fn a_permission_on_screen_is_never_typed_into() {
        // Even at the prompt: the dialog is the user's question, and a line
        // landing under it would answer in the orchestrator's voice.
        let waiting = Target {
            waiting_on_user: true,
            ..ready()
        };
        assert_eq!(
            flush(&waiting, Mode::Queue, false),
            Decision::Settle {
                state: STATE_REFUSED,
                reason: "WAITING_ON_USER"
            }
        );
    }

    #[test]
    fn an_orchestrator_never_takes_a_dispatch() {
        let peer = Target {
            role: Some("orchestrator".into()),
            ..ready()
        };
        assert_eq!(
            flush(&peer, Mode::Now, false),
            Decision::Settle {
                state: STATE_REFUSED,
                reason: "NO_ORCHESTRATOR_TO_ORCHESTRATOR"
            }
        );
    }

    #[test]
    fn a_muted_target_stays_muted() {
        let muted = Target {
            accept_dispatch: false,
            ..ready()
        };
        assert_eq!(
            flush(&muted, Mode::Queue, false),
            Decision::Settle {
                state: STATE_REFUSED,
                reason: "MUTED"
            }
        );
    }

    #[test]
    fn a_scoped_project_belongs_to_its_own_orchestrator() {
        let owned = Target {
            scope_taken: true,
            ..ready()
        };
        assert_eq!(
            flush(&owned, Mode::Queue, false),
            Decision::Settle {
                state: STATE_REFUSED,
                reason: "SCOPE_TAKEN"
            }
        );
    }

    #[test]
    fn ttl_outranks_everything_and_names_the_drop() {
        // Even a target that would refuse for a better-sounding reason: an
        // expired line is stale context, and `no_device` is what the
        // orchestrator can act on.
        let waiting = Target {
            waiting_on_user: true,
            ..ready()
        };
        assert_eq!(
            flush(&waiting, Mode::Queue, true),
            Decision::Settle {
                state: STATE_DROPPED,
                reason: "no_device"
            }
        );
    }

    #[test]
    fn an_unknown_mode_word_queues_rather_than_types() {
        assert_eq!(Mode::parse("now"), Mode::Now);
        assert_eq!(Mode::parse("queue"), Mode::Queue);
        assert_eq!(Mode::parse("immediately"), Mode::Queue);
    }
}
