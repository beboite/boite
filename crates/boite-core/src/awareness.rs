//! What a thread means to somebody who is not looking at it.
//!
//! A status is a measurement. This is the one framing built on top of it, and
//! every consumer that has to say something about a thread out loud reads it:
//! the outbound webhook, Web Push, and the in-app bar that offers an answer.
//! Before it there were four places composing their own sentence out of the
//! same eight strings, and the webhook's version had no verb in it at all.
//!
//! **Pure, and deliberately downstream of the status decision.** Nothing here
//! measures anything. It takes a status somebody else already decided — the
//! engine on the desktop, `registry.rs` on the server — and answers what it
//! means. That separation is what stops this from becoming the second copy of
//! status detection that `ARCHITECTURE.md` opens by warning about.
//!
//! The status-to-phase table lives in `src/lib/domain/awareness.json`, read
//! from here by a test and by the frontend at runtime, so the two cannot drift
//! without `cargo test` saying so.

use serde::Serialize;

use crate::status::ThreadStatus;

/// What is happening to a thread, in the words a notification uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// A row with no turn behind it yet.
    Starting,
    /// A turn is in flight.
    Running,
    /// Blocked on the user, and Boite knows what is being asked: an agent put a
    /// request through the endpoint and it is sitting in `approvals`.
    WaitingForApproval,
    /// Blocked on the user, and the question is on the terminal rather than in a
    /// row: a permission prompt, a plan to accept, any dialog the agent drew.
    WaitingForInput,
    /// The turn ended.
    Completed,
    /// The process is gone and did not leave cleanly.
    Failed,
    /// The row claims something the machine cannot back up: a live status with
    /// no process behind it, or a terminal that was put to sleep.
    Stale,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Starting => "starting",
            Phase::Running => "running",
            Phase::WaitingForApproval => "waiting_for_approval",
            Phase::WaitingForInput => "waiting_for_input",
            Phase::Completed => "completed",
            Phase::Failed => "failed",
            Phase::Stale => "stale",
        }
    }

    /// Nothing moves until a person does something.
    ///
    /// The one question every consumer asks, and the reason `waiting` is its own
    /// status rather than a flavour of ready.
    pub fn needs_a_human(self) -> bool {
        matches!(self, Phase::WaitingForApproval | Phase::WaitingForInput)
    }

    /// ntfy's tag, which is how that client picks an emoji.
    pub fn tag(self) -> &'static str {
        match self {
            Phase::Starting => "hourglass",
            Phase::Running => "gear",
            Phase::WaitingForApproval => "lock",
            Phase::WaitingForInput => "bell",
            Phase::Completed => "white_check_mark",
            Phase::Failed => "x",
            Phase::Stale => "ghost",
        }
    }

    /// ntfy's priority. Only the two that hold a turn open are raised: a
    /// notification channel that shouts about everything is one the user mutes,
    /// and muting it costs the case this whole feature exists for.
    pub fn priority(self) -> &'static str {
        if self.needs_a_human() {
            "high"
        } else {
            "default"
        }
    }

    /// Discord's embed stripe. Grayscale plus the three status colours the app
    /// itself uses, so a card looks like the thing it is describing.
    pub fn color(self) -> u32 {
        match self {
            Phase::WaitingForApproval | Phase::WaitingForInput => 0xf59e0b,
            Phase::Failed => 0xef4444,
            Phase::Completed => 0x22c55e,
            _ => 0x71717a,
        }
    }
}

/// What a host knows about a thread when it has to speak for it.
///
/// Borrowed rather than owned: the caller is a notifier loop holding rows it
/// already read, and this is built once per event.
pub struct Facts<'a> {
    pub thread_id: &'a str,
    /// The live OSC title where there is one, the user's label otherwise.
    pub label: &'a str,
    pub project_id: Option<&'a str>,
    pub project: Option<&'a str>,
    pub status: ThreadStatus,
    pub exit_code: Option<i32>,
    /// This host has a process for this thread right now.
    ///
    /// The comparison `system.snapshot` exists to make: a row saying `running`
    /// with nothing behind it is not work in flight, and telling somebody who is
    /// away from the machine that it is would be the one lie this value can tell.
    pub has_process: bool,
    /// The sentence of the approval this thread is waiting behind, when it is
    /// waiting behind one.
    pub approval: Option<&'a str>,
}

/// The whole value, ready to be serialized into a webhook body or a push
/// payload. Nothing on it is a secret: it names a thread, a project and a path.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Awareness {
    pub phase: &'static str,
    /// What a person reads as a notification title.
    pub headline: String,
    pub detail: String,
    pub thread_id: String,
    pub thread: String,
    pub project_id: Option<String>,
    pub project: Option<String>,
    /// Where to go, as a path and query rather than a URL.
    ///
    /// The two hosts resolve it differently and neither can build the other's:
    /// the PWA resolves it against the origin it was served from, and the
    /// desktop has no origin at all — it parses the query and moves the window
    /// it already has. A server that knows its own public address turns this
    /// into an absolute one on the way out (`BOITE_PUBLIC_URL`).
    pub link: String,
}

/// The phase, from a status somebody else decided.
///
/// Two things override the table, and both are the machine disagreeing with the
/// row rather than a second opinion about it.
pub fn phase(status: ThreadStatus, has_process: bool, approval: bool) -> Phase {
    match status {
        // First, and ahead of the staleness check on purpose. An approval is a
        // row: it is open until somebody answers it, and it outlives the
        // terminal that asked. An agent wired from a credentials file has no PTY
        // here at all, so deciding this on whether a process is alive would
        // silence the requests that most need a person.
        ThreadStatus::Waiting if approval => Phase::WaitingForApproval,
        ThreadStatus::Running | ThreadStatus::Waiting if !has_process => Phase::Stale,
        ThreadStatus::Waiting => Phase::WaitingForInput,
        ThreadStatus::Running => Phase::Running,
        ThreadStatus::Ready | ThreadStatus::Done => Phase::Completed,
        ThreadStatus::Exited | ThreadStatus::Error => Phase::Failed,
        // Parked, not gone. Neither has a turn behind it and neither is worth
        // waking somebody for, which is the only distinction this value draws.
        ThreadStatus::Idle => Phase::Starting,
        ThreadStatus::Stopped => Phase::Stale,
    }
}

/// The path that opens this thread. One copy; `src/lib/domain/awareness.ts`
/// parses what this writes.
pub fn link(thread_id: &str, project_id: Option<&str>) -> String {
    let mut out = format!("/?thread={}", encode(thread_id));
    if let Some(project) = project_id {
        out.push_str(&format!("&project={}", encode(project)));
    }
    out
}

fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub fn derive(f: &Facts<'_>) -> Awareness {
    let phase = phase(f.status, f.has_process, f.approval.is_some());
    let who = if f.label.trim().is_empty() {
        "A terminal"
    } else {
        f.label.trim()
    };
    let headline = match phase {
        Phase::Starting => format!("{who} has not started"),
        Phase::Running => format!("{who} is working"),
        Phase::WaitingForApproval => format!("{who} needs your approval"),
        Phase::WaitingForInput => format!("{who} needs an answer"),
        Phase::Completed => format!("{who} is ready"),
        Phase::Failed => format!("{who} exited"),
        Phase::Stale => format!("{who} went quiet"),
    };
    let detail = match phase {
        Phase::Starting => in_project("Nothing has run in it yet", f.project),
        Phase::Running => in_project("A turn is in flight", f.project),
        // The agent said what it wants; repeating "it needs an answer" here
        // would spend the one line a lock screen shows on saying it twice.
        Phase::WaitingForApproval => f
            .approval
            .map(|s| s.to_string())
            .unwrap_or_else(|| in_project("It is waiting on you", f.project)),
        Phase::WaitingForInput => in_project(
            "A dialog is up and nothing moves until you answer",
            f.project,
        ),
        Phase::Completed => in_project("The turn ended; it takes input again", f.project),
        Phase::Failed => match f.exit_code {
            Some(code) if code != 0 => in_project(&format!("Exit code {code}"), f.project),
            _ => in_project("The process is gone", f.project),
        },
        Phase::Stale => match f.status {
            ThreadStatus::Stopped => in_project("Put to sleep; its PTY was released", f.project),
            other => in_project(
                &format!("Its row says {} and no process is behind it", other.as_str()),
                f.project,
            ),
        },
    };
    Awareness {
        phase: phase.as_str(),
        headline,
        detail,
        thread_id: f.thread_id.to_string(),
        thread: who.to_string(),
        project_id: f.project_id.map(str::to_string),
        project: f.project.map(str::to_string),
        link: link(f.thread_id, f.project_id),
    }
}

fn in_project(sentence: &str, project: Option<&str>) -> String {
    match project.map(str::trim).filter(|p| !p.is_empty()) {
        Some(project) => format!("{sentence} — {project}"),
        None => sentence.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts<'a>(status: ThreadStatus, has_process: bool) -> Facts<'a> {
        Facts {
            thread_id: "t-1",
            label: "Claude #1",
            project_id: Some("p-1"),
            project: Some("boite"),
            status,
            exit_code: None,
            has_process,
            approval: None,
        }
    }

    #[test]
    fn every_status_reaches_a_phase_and_every_phase_is_reachable() {
        use std::collections::HashSet;
        let mut seen: HashSet<&str> = HashSet::new();
        for status in [
            ThreadStatus::Idle,
            ThreadStatus::Running,
            ThreadStatus::Waiting,
            ThreadStatus::Ready,
            ThreadStatus::Done,
            ThreadStatus::Exited,
            ThreadStatus::Error,
            ThreadStatus::Stopped,
        ] {
            for has_process in [true, false] {
                for approval in [true, false] {
                    seen.insert(phase(status, has_process, approval).as_str());
                }
            }
        }
        let mut got: Vec<&str> = seen.into_iter().collect();
        got.sort_unstable();
        assert_eq!(
            got,
            [
                "completed",
                "failed",
                "running",
                "stale",
                "starting",
                "waiting_for_approval",
                "waiting_for_input",
            ],
            "a phase nothing can produce is a phase nothing downstream will ever draw"
        );
    }

    /// The one the frontend imports. Drift here is a phone showing a different
    /// sentence from the one that woke it.
    #[test]
    fn the_shared_table_says_what_this_module_says() {
        let raw = include_str!("../../../src/lib/domain/awareness.json");
        let table: serde_json::Value = serde_json::from_str(raw).expect("awareness.json parses");
        let phases = table["phases"].as_object().expect("phases is an object");
        assert_eq!(phases.len(), 8, "one row per ThreadStatus");
        for (status, expected) in phases {
            let parsed = match status.as_str() {
                "idle" => ThreadStatus::Idle,
                "running" => ThreadStatus::Running,
                "waiting" => ThreadStatus::Waiting,
                "ready" => ThreadStatus::Ready,
                "done" => ThreadStatus::Done,
                "exited" => ThreadStatus::Exited,
                "error" => ThreadStatus::Error,
                "stopped" => ThreadStatus::Stopped,
                other => panic!("awareness.json names a status that does not exist: {other}"),
            };
            assert_eq!(
                phase(parsed, true, false).as_str(),
                expected.as_str().unwrap(),
                "{status}"
            );
        }
    }

    /// The thread nobody is looking at, which is the only reason any of this
    /// exists. A row left claiming a live turn must not reach a phone as work in
    /// flight: there is nothing to wait for and nothing to answer.
    #[test]
    fn a_row_with_no_process_behind_it_is_stale_whatever_it_claims() {
        for status in [ThreadStatus::Running, ThreadStatus::Waiting] {
            let a = derive(&facts(status, false));
            assert_eq!(a.phase, "stale", "{status:?}");
            assert!(a.detail.contains("no process is behind it"), "{}", a.detail);
        }
        // And with a process it is the ordinary answer again, or the guard above
        // would just be breaking the live statuses instead.
        assert_eq!(derive(&facts(ThreadStatus::Running, true)).phase, "running");
        assert_eq!(
            derive(&facts(ThreadStatus::Waiting, true)).phase,
            "waiting_for_input"
        );
    }

    #[test]
    fn an_open_approval_names_itself_rather_than_repeating_the_headline() {
        let mut f = facts(ThreadStatus::Waiting, true);
        f.approval = Some("Wants to create the project scratchpad");
        let a = derive(&f);
        assert_eq!(a.phase, "waiting_for_approval");
        assert_eq!(a.headline, "Claude #1 needs your approval");
        assert_eq!(a.detail, "Wants to create the project scratchpad");
        assert!(phase(ThreadStatus::Waiting, true, true).needs_a_human());
        // And with no terminal behind it, which is what an agent wired from a
        // credentials file looks like. The row is still open.
        f.has_process = false;
        assert_eq!(derive(&f).phase, "waiting_for_approval");
    }

    #[test]
    fn a_dialog_on_the_terminal_is_the_other_waiting_phase() {
        let a = derive(&facts(ThreadStatus::Waiting, true));
        assert_eq!(a.phase, "waiting_for_input");
        assert_eq!(a.headline, "Claude #1 needs an answer");
        assert!(a.detail.starts_with("A dialog is up"));
        assert!(a.detail.ends_with("— boite"));
    }

    #[test]
    fn a_finished_turn_and_a_finished_process_are_different_phases() {
        assert_eq!(derive(&facts(ThreadStatus::Ready, true)).phase, "completed");
        assert_eq!(derive(&facts(ThreadStatus::Done, false)).phase, "completed");
        let mut f = facts(ThreadStatus::Exited, false);
        f.exit_code = Some(137);
        let a = derive(&f);
        assert_eq!(a.phase, "failed");
        assert_eq!(a.headline, "Claude #1 exited");
        assert_eq!(a.detail, "Exit code 137 — boite");
        assert_eq!(derive(&facts(ThreadStatus::Error, false)).phase, "failed");
    }

    #[test]
    fn a_thread_that_never_ran_and_one_that_was_slept_are_told_apart() {
        let starting = derive(&facts(ThreadStatus::Idle, false));
        assert_eq!(starting.phase, "starting");
        assert_eq!(starting.headline, "Claude #1 has not started");
        let slept = derive(&facts(ThreadStatus::Stopped, false));
        assert_eq!(slept.phase, "stale");
        assert!(slept.detail.starts_with("Put to sleep"));
        assert!(!phase(ThreadStatus::Stopped, false, false).needs_a_human());
    }

    #[test]
    fn a_thread_with_no_label_and_no_project_still_says_something() {
        let a = derive(&Facts {
            thread_id: "t-9",
            label: "   ",
            project_id: None,
            project: None,
            status: ThreadStatus::Ready,
            exit_code: None,
            has_process: true,
            approval: None,
        });
        assert_eq!(a.headline, "A terminal is ready");
        assert_eq!(a.detail, "The turn ended; it takes input again");
        assert_eq!(a.link, "/?thread=t-9");
        assert_eq!(a.project, None);
    }

    #[test]
    fn a_link_carries_the_thread_and_survives_an_id_with_punctuation_in_it() {
        assert_eq!(link("abc", Some("p1")), "/?thread=abc&project=p1");
        assert_eq!(link("abc", None), "/?thread=abc");
        assert_eq!(
            link("a b&c=d", Some("p/1")),
            "/?thread=a%20b%26c%3Dd&project=p%2F1"
        );
    }

    #[test]
    fn only_the_two_blocking_phases_ask_for_a_person() {
        for (p, expected) in [
            (Phase::Starting, false),
            (Phase::Running, false),
            (Phase::WaitingForApproval, true),
            (Phase::WaitingForInput, true),
            (Phase::Completed, false),
            (Phase::Failed, false),
            (Phase::Stale, false),
        ] {
            assert_eq!(p.needs_a_human(), expected, "{}", p.as_str());
            assert_eq!(p.priority() == "high", expected, "{}", p.as_str());
        }
    }
}
