//! Asking the user before an agent does something it should not decide alone.
//!
//! Three calls reach past the project an agent is working in: moving its thread
//! somewhere else, opening a terminal in another project, and creating one.
//! `capability::MutateAcross` already refuses those to a credential with no
//! terminal behind it. This is the other half, for the credential that does have
//! one: the agent may ask, and the user answers.
//!
//! **The agent does not wait.** It is told the request is with the user, told
//! not to retry, and carries on. A tool call that blocks on a human is a turn
//! that stalls until somebody happens to look at the window, and an agent that
//! gets no answer retries, which is how one careless prompt becomes forty
//! notifications.
//!
//! What is stored is the whole dispatch, verbatim, so a decision replays exactly
//! what was asked for rather than a reconstruction of it. That is the mistake
//! `block/buzz` made in the other order: the approval command, the desktop card,
//! the relay executor and the token hash all exist there, and the one place that
//! creates the record is a `TODO`.

use serde::{Deserialize, Serialize};

/// A request waiting on a human.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub id: String,
    /// The project the *caller* is in, which is where the card is shown and
    /// where the journal entry goes. Not the project being reached into.
    pub project_id: String,
    /// The thread that asked. Empty is possible in principle and does not
    /// happen: only a credential with a terminal can reach a gated call.
    pub thread_id: String,
    /// What is being asked for, as the endpoint's own verb: `thread.move`,
    /// `project.create`, `thread.spawn`.
    pub action: String,
    /// One line for the card. The project being moved into, the name of the
    /// project being created.
    pub detail: String,
    pub created_at: i64,
}

/// What became of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Pending,
    Allowed,
    Refused,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Pending => "pending",
            Verdict::Allowed => "allowed",
            Verdict::Refused => "refused",
        }
    }

    /// Anything unreadable is `Pending`, which is the safe reading: a row whose
    /// verdict cannot be understood has not been acted on.
    pub fn parse(raw: &str) -> Verdict {
        match raw {
            "allowed" => Verdict::Allowed,
            "refused" => Verdict::Refused,
            _ => Verdict::Pending,
        }
    }
}

/// The `status` an agent reads while its call sits in front of the user.
///
/// A word rather than an `error`, because it is not one. The endpoint used to
/// answer these the way it answers a project that does not exist, and every
/// client on the other side treats an `error` field as a failed call: agents
/// apologised for something that had not gone wrong, then went looking for
/// another way round the gate.
pub const AWAITING: &str = "awaiting-user";

/// The `status` when the workspace answered for the user, see `mcpYolo`.
pub const AUTO_ALLOWED: &str = "auto-allowed";

/// What an agent reads when a call is put to the user.
///
/// Says the call worked before it says anything else. `retryable: false` rides
/// along because nothing about asking again changes the answer, and the wording
/// says who has it now, so the agent explains the wait rather than reporting a
/// failure or reaching for a workaround.
pub fn waiting_on_a_human(action: &str) -> String {
    format!(
        "{action} worked: the call was accepted and is now waiting for the user to \
         allow it in Boite. This is not a refusal and nothing failed. It runs on \
         its own the moment they accept, so do not ask again and do not look for \
         another way round it. Carry on with something else, or say you are \
         waiting on them."
    )
}

/// What an agent reads when the workspace allowed it without asking.
///
/// Worth a sentence of its own: the same call answers two ways depending on a
/// setting the agent cannot see, and "it already ran" is the half that changes
/// what it should do next.
pub fn answered_by_yolo(action: &str) -> String {
    format!(
        "{action} ran straight away. This workspace is in yolo mode, so Boite \
         answers for the user on the calls that would otherwise wait for them."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_verdict_round_trips_and_fails_closed() {
        for verdict in [Verdict::Pending, Verdict::Allowed, Verdict::Refused] {
            assert_eq!(Verdict::parse(verdict.as_str()), verdict);
        }
        // A row written by a newer version, or a corrupted one, has not been
        // acted on as far as this version is concerned.
        assert_eq!(Verdict::parse("whatever"), Verdict::Pending);
        assert_eq!(Verdict::parse(""), Verdict::Pending);
    }

    /// The sentence an agent reads is the whole interface here, so it has to
    /// say the call worked, who has it, and that retrying is pointless.
    #[test]
    fn the_agent_is_told_it_worked_and_not_to_retry() {
        let said = waiting_on_a_human("thread.move");
        assert!(said.contains("thread.move"));
        assert!(said.contains("worked"));
        assert!(said.contains("not a refusal"));
        assert!(said.contains("do not ask again"));
        assert!(said.contains("user"));
    }

    /// The other half of the same interface: allowed without asking is a
    /// different next move from waiting, so it does not borrow the wording.
    #[test]
    fn yolo_says_the_call_already_ran() {
        let said = answered_by_yolo("project.create");
        assert!(said.contains("project.create"));
        assert!(said.contains("ran straight away"));
        assert!(!said.contains("waiting"));
    }
}
