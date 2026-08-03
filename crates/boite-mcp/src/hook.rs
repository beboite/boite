//! The one lifecycle hook this shim answers: an agent saying it is done.
//!
//! The same binary, under `--hook stop`. It is not an MCP tool and could not be
//! one: a tool is something the model chooses to call, and the whole point here
//! is the turn where it chose not to. The agent's own runner invokes it, reads
//! one JSON object off stdout, and either lets the turn end or hands the reason
//! back to the model.
//!
//! **Everything that is not a clear objection allows the stop.** No credentials,
//! no endpoint, a timeout, a body that does not parse, a status that is not 200:
//! all of them print nothing and exit 0. This is the only mechanism in Boite
//! that can keep a conversation open against the user's wishes, so it fails in
//! the direction of letting go.
//!
//! Three rails, and each closes a way a hook turns into a trap:
//!
//! - `stop_hook_active` is the runner telling us the agent is only still going
//!   because a stop hook sent it back. Answering again there is the loop, so it
//!   is the first thing read and it allows unconditionally.
//! - `BOITE_STOP_HOOK=off` switches it off for a terminal without editing a file
//!   Boite rewrites on every launch.
//! - The message itself says the check runs once, so an agent reads a block as
//!   work to do rather than as a wall to route around.

use serde_json::Value;

use crate::host::Host;

/// What the runner is told.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// Print nothing. The turn ends.
    Allow,
    /// Hand this back to the model as the reason it is still going.
    Block(String),
}

impl Verdict {
    /// The JSON line the runner reads, or nothing at all.
    ///
    /// Silence is the allow: a runner that gets an empty stdout and a zero exit
    /// has nothing to decide, which is exactly what should happen on the turns
    /// where everything is finished, and those are most of them.
    pub(crate) fn line(&self) -> Option<String> {
        match self {
            Verdict::Allow => None,
            Verdict::Block(reason) => Some(
                serde_json::json!({ "decision": "block", "reason": reason }).to_string(),
            ),
        }
    }
}

/// Whether the runner already sent this agent back once for this stop.
///
/// The rail that makes a loop impossible rather than unlikely. A hook that
/// answers a second time for the same stop can answer a third, and the agent is
/// then held by a check it has no way to satisfy from inside the conversation.
pub(crate) fn already_ran(payload: &Value) -> bool {
    payload
        .get("stop_hook_active")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Whether the user switched it off for this terminal.
fn switched_off() -> bool {
    std::env::var("BOITE_STOP_HOOK")
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            v == "off" || v == "0" || v == "false"
        })
        .unwrap_or(false)
}

/// The verdict for one stop, given whatever the runner sent on stdin.
///
/// The payload is read before anything else is attempted: an agent that is only
/// still running because of this hook must be let go before a socket is even
/// opened, or a Boite that is slow to answer becomes a Boite that hangs every
/// turn twice.
pub(crate) fn decide(stdin: &str) -> Verdict {
    let payload: Value = serde_json::from_str(stdin).unwrap_or(Value::Null);
    if already_ran(&payload) || switched_off() {
        return Verdict::Allow;
    }
    let Ok(host) = Host::resolve() else {
        return Verdict::Allow;
    };
    let Ok(answer) = host.send("GET", "/v1/finish", None) else {
        return Verdict::Allow;
    };
    match answer.get("reason").and_then(Value::as_str) {
        Some(reason) if !reason.trim().is_empty() => Verdict::Block(reason.to_string()),
        _ => Verdict::Allow,
    }
}

/// Reads stdin, prints the verdict, and never returns a failing status.
///
/// A non-zero exit from a Stop hook is itself a way of blocking in some runners,
/// so this one exits 0 whatever happened. What it has to say, it says in the
/// object on stdout.
pub(crate) fn run() -> ! {
    use std::io::Read;
    let mut stdin = String::new();
    let _ = std::io::stdin().read_to_string(&mut stdin);
    if let Some(line) = decide(&stdin).line() {
        println!("{line}");
    }
    std::process::exit(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The rail. Without it a block sends the agent back, the next stop asks
    /// again, and the conversation cannot end.
    #[test]
    fn a_stop_that_already_asked_is_let_go() {
        assert!(already_ran(&json!({ "stop_hook_active": true })));
        assert!(!already_ran(&json!({ "stop_hook_active": false })));
        // And a payload that says nothing about it has not asked yet.
        assert!(!already_ran(&json!({})));
        assert!(!already_ran(&Value::Null));
    }

    /// Reached with no environment, so `Host::resolve` fails and the verdict is
    /// the one every failure gives.
    #[test]
    fn anything_it_cannot_decide_allows() {
        assert_eq!(decide("not json"), Verdict::Allow);
        assert_eq!(decide(""), Verdict::Allow);
        assert_eq!(decide(r#"{"stop_hook_active":true}"#), Verdict::Allow);
    }

    #[test]
    fn allowing_prints_nothing_and_blocking_prints_one_object() {
        assert_eq!(Verdict::Allow.line(), None);
        let line = Verdict::Block("commit it".into()).line().unwrap();
        let parsed: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["decision"], "block");
        assert_eq!(parsed["reason"], "commit it");
        // One line: the runner reads stdout as a single object.
        assert!(!line.contains('\n'));
    }
}
