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

/// What an agent reads when a call is put to the user.
///
/// A `200` carrying an error rather than a status code, like every other refusal
/// an agent is meant to act on, and `retryable: false` because nothing about
/// asking again changes the answer. The wording says who has it now, so the
/// agent explains the wait rather than reporting a failure.
pub fn waiting_on_a_human(action: &str) -> String {
    format!(
        "{action} is with the user to approve. Do not ask again: they will see it \
         in Boite, and the call runs on its own if they allow it. Carry on with \
         something else, or say you are waiting."
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
    /// say who has it and that retrying is pointless.
    #[test]
    fn the_agent_is_told_not_to_retry() {
        let said = waiting_on_a_human("thread.move");
        assert!(said.contains("thread.move"));
        assert!(said.contains("Do not ask again"));
        assert!(said.contains("user"));
    }
}
