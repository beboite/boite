//! The door an agent uses to reach its own workspace.
//!
//! Ten routes, and until this crate existed there were two hand-kept copies of
//! them: one in the desktop app, one in the server. Nine of the eleven
//! verb-and-route pairs had drifted apart. One side refused a request no device
//! could carry out and the other answered success; one side wrote every mutation
//! to the project's log and the other wrote nothing; one side ran three `git`
//! processes off the async runtime and the other ran them on it. None of that
//! was a decision — the server binary is a crate nothing can depend on, so the
//! second copy was the only way to have the feature at all.
//!
//! What differs between the two hosts is real and small: where a request goes
//! once it is understood, and who else is watching. That is the [`Workspace`]
//! trait. Everything else — the token check, who the caller is, what a refusal
//! says, what lands in the log — is here, once.
//!
//! ```text
//!   desktop Inner ─┐                                  ┌─ identify   one proof of who
//!                  ├─ dyn Workspace ── router() ──────┤─ handlers   one behaviour
//!   server  Inner ─┘                                  └─ journal    one history
//! ```

use std::sync::Arc;

use boite_core::scope::ProjectRoots;
use boite_core::store::Store;

mod auth;
pub mod keys;
mod routes;
#[cfg(test)]
mod testing;

pub use auth::{known_agent, Caller};
pub use boite_identity::env;
pub use routes::router;

/// What changed, for the devices that are drawing it.
///
/// Two kinds, because the two of them refresh different things. The server used
/// to announce a claimed branch as a todo change, which is not wrong so much as
/// a device being told to re-read the wrong list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Todos,
    Worktrees,
    /// Something is waiting on the user. See `boite_core::approval`.
    Approvals,
}

/// What an agent is told when it asks for something no device is there to do.
///
/// It used to be told nothing: the send failed with no receiver, the error was
/// dropped on the floor and the handler answered success anyway. On a headless
/// boite with nobody connected the agent read `moving to <project>`, carried on
/// as if it had moved, and no PTY had been touched.
pub const NOBODY_TO_CARRY_IT_OUT: &str =
    "no Boite device is connected, and the server cannot do this on its own: it means killing a      PTY and rearranging rows a client owns. Open Boite on a device and ask again.";

/// What the RPC says when a folder sits outside every place a project may go.
/// One wording for both endpoints; see the constant's own comment for why.
pub use boite_core::project::WRONG_PLACE_FOR_A_PROJECT;

/// The workspace behind the endpoint: what the two hosts genuinely do
/// differently.
///
/// Deliberately small. Everything a handler can work out from the database, the
/// filesystem or the request itself is not in here, which is what keeps the two
/// implementations from being two behaviours again.
pub trait Workspace: Send + Sync + 'static {
    /// The database. Shared, so a handler reads and writes the same rows on
    /// both sides.
    fn store(&self) -> &Store;

    /// The filesystem trust boundary, so where a project may be created is one
    /// rule rather than two that drift.
    fn roots(&self) -> &ProjectRoots;

    /// The workspace secret. Never handed to anybody as it is.
    ///
    /// One value per run of the process, and the only thing derived from it is
    /// a per-project token for a credentials file, through
    /// `boite_identity::project_token`. A thread never sees it at all: it signs
    /// with a key of its own, and this endpoint verifies against the public half
    /// on its row.
    fn secret(&self) -> &str;

    /// Places a project may go beyond the parents of the registered roots.
    ///
    /// The user's home on both sides; a server bound to a workspace directory
    /// adds that too. Empty is a valid answer and means the parents are the
    /// whole of it.
    fn extra_project_parents(&self) -> Vec<String> {
        dirs::home_dir()
            .map(|home| vec![home.to_string_lossy().to_string()])
            .unwrap_or_default()
    }

    /// Hands a request to whoever can carry it out.
    ///
    /// The endpoint owns none of these: moving a thread means killing a PTY and
    /// opening a worktree, and a client drives both. `Err` is the sentence the
    /// agent reads, so a host that has nobody to ask says
    /// [`NOBODY_TO_CARRY_IT_OUT`] rather than answering success.
    fn ask(&self, request: serde_json::Value) -> Result<(), String>;

    /// Something changed that every device should re-read.
    fn announce(&self, change: Change);

    /// The PTYs this host still has a process for.
    ///
    /// The half a database row cannot know, and the half the snapshot exists
    /// for: a thread whose status says `running` and whose id is not in here is
    /// the shape of nearly every "my terminal is dead" report. The default is
    /// empty because a host might genuinely run no terminals; one that does and
    /// answers empty makes the snapshot lie, so both of Boite's implement it.
    fn live_ptys(&self) -> Vec<boite_core::snapshot::LivePty> {
        Vec::new()
    }

    /// Where this host keeps what its terminals printed.
    ///
    /// `None` means it keeps none. Answered rather than assumed, because "no
    /// transcript for that thread" and "this Boite writes none" send an agent
    /// to two different places.
    fn transcripts_dir(&self) -> Option<std::path::PathBuf> {
        None
    }

    /// What is on this host's window, when it has one.
    ///
    /// `None` on the server, which has no window, and on a desktop whose webview
    /// has not described itself yet. It is the last question an agent had to ask
    /// a human, and the default answer is the honest one for a host that cannot
    /// know: see `boite_core::screen`.
    fn on_screen(&self) -> Option<boite_core::screen::Screen> {
        None
    }

    /// Called after an agent acts, for whatever the host shows about it.
    ///
    /// The desktop pulses the thread's dot in the sidebar. The server has no
    /// equivalent and does not need one, which is why this has a default.
    fn touched(&self, _thread_id: &str, _what: &str) {}

    /// Hands a request to the device and keeps the line open for its answer.
    ///
    /// What [`Workspace::ask`] is for a verb, this is for a question: reading a
    /// page in a browser pane means asking the webview that is drawing it, and
    /// the answer has to come back to the very call that asked. The receiver
    /// resolves when the device answers; the caller owns the timeout, because
    /// only it knows how long its agent will sit there.
    ///
    /// The default is the server's honest answer. Its devices are browsers and
    /// phones drawing panes this process cannot reach into, and pretending
    /// otherwise would hand an agent an empty snapshot labelled as the page.
    fn ask_for_answer(
        &self,
        _request: serde_json::Value,
    ) -> Result<tokio::sync::oneshot::Receiver<serde_json::Value>, String> {
        Err(DEVICE_CANNOT_ANSWER.to_string())
    }
}

/// What an agent is told when it asks a question only a desktop window can
/// answer, on a host whose devices cannot.
pub const DEVICE_CANNOT_ANSWER: &str =
    "this Boite cannot reach inside the pane: the device drawing it is a browser or a phone, \
     and only a Boite desktop window can read and drive a page. Navigate, reload and close \
     still work from here.";

/// The concrete state axum carries. A handler never sees anything else.
pub type Shared = Arc<dyn Workspace>;

/// Answers a request an agent put in front of the user.
///
/// Shared rather than written once per host, because the interesting half is
/// not the update: it is that allowing one replays the dispatch that was stored
/// with it, verbatim. Two copies of that would be two ideas of what the user
/// agreed to.
///
/// `None` means somebody already answered it, which is what a second device
/// looking at the same card gets. Not an error: the request has been dealt
/// with, and telling the user it failed would be worse than saying nothing.
pub fn decide(
    workspace: &dyn Workspace,
    id: &str,
    verdict: boite_core::approval::Verdict,
    now: i64,
) -> Result<Option<boite_core::approval::Pending>, String> {
    use boite_core::approval::Verdict;
    use boite_core::journal::{Action, Actor, Entry};

    let Some((pending, request)) = workspace.store().decide_approval(id, verdict, now)? else {
        return Ok(None);
    };
    let mut entry = Entry::new(
        &pending.project_id,
        // The user, not the thread. The thread asked; this is the answer.
        Actor::System,
        Action::ApprovalDecided,
    )
    .about(&pending.id)
    .with("of", &pending.action)
    .with("verdict", verdict.as_str());

    if verdict == Verdict::Allowed {
        // The dispatch as it was recorded. Nothing is rebuilt from the pending
        // row, so what runs is what the card described.
        if let Err(reason) = workspace.ask(request) {
            entry = entry.with("failed", &reason);
        }
    }
    if let Err(e) = workspace.store().record(entry) {
        eprintln!("[boite/agent-api] journal write failed: {e}");
    }
    workspace.announce(Change::Approvals);
    Ok(Some(pending))
}
