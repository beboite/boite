//! Threads driven by protocol.
//!
//! A `terminal` thread is a PTY boite watches from the outside. A `pilot`
//! thread is an agent process boite talks to over the agent's own machine
//! protocol, so the status, the session id and the tool approvals are told
//! rather than guessed. `docs/pilot.md` is the contract; this crate is the part
//! that owns the child processes.
//!
//! Everything above it stays synchronous: `boite_core::command` validates a
//! call, checks the grant and hands a `Ready` to the host, and the host owns
//! the tokio runtime this crate needs. The bus itself takes no executor.

pub mod claude;
pub mod driver;
pub mod event;
pub mod proc;
pub mod scripted;

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

pub use driver::{
    Capabilities, Driver, EventSink, ExecMode, Instance, McpServer, ModelSelection, OpenSpec,
    Opened, Options, PilotError, RequestAnswer, Session, SessionSink, SwitchKind, TurnId, TurnInput,
};
pub use event::{
    ExitReason, Item, ItemKind, PilotEvent, Request, RequestKind, RequestOption, RequestOutcome,
    Status, Usage,
};

/// The sessions a host has open, one per thread.
///
/// A `Runtime` owns no executor of its own: every method is async and runs on
/// the host's. Sessions are held behind a lock that is never held across an
/// await, the map being read far more often (once per sidebar pass, per thread)
/// than it is written.
pub struct Runtime {
    sink: Arc<dyn EventSink>,
    sessions: Mutex<HashMap<String, Arc<dyn Session>>>,
    drivers: Mutex<HashMap<String, Arc<dyn Driver>>>,
}

impl Runtime {
    /// A runtime with the drivers this build ships.
    pub fn new(sink: Arc<dyn EventSink>) -> Self {
        let runtime =
            Self { sink, sessions: Mutex::new(HashMap::new()), drivers: Mutex::new(HashMap::new()) };
        runtime.register(Arc::new(claude::ClaudeDriver));
        runtime.register(Arc::new(scripted::ScriptedDriver::from_env()));
        runtime
    }

    /// Add or replace a driver. A test registers a scripted one under the name
    /// it wants to stand in for.
    pub fn register(&self, driver: Arc<dyn Driver>) {
        self.drivers.lock().insert(driver.id().to_string(), driver);
    }

    /// What a driver can do, asked before the interface offers it.
    pub fn capabilities(&self, driver: &str) -> Option<Capabilities> {
        self.drivers.lock().get(driver).map(|driver| driver.capabilities())
    }

    /// The drivers this runtime knows, sorted.
    pub fn drivers(&self) -> Vec<String> {
        let mut names: Vec<String> = self.drivers.lock().keys().cloned().collect();
        names.sort();
        names
    }

    /// Start or resume the native session of a thread.
    ///
    /// Opening a thread that already has a session stops the old one first: two
    /// children on one thread would both answer, and the second `--session-id`
    /// would collide with the first on the same transcript.
    pub async fn open(&self, spec: OpenSpec) -> Result<Opened, PilotError> {
        let driver = self
            .drivers
            .lock()
            .get(&spec.driver)
            .cloned()
            .ok_or_else(|| PilotError::UnknownDriver(spec.driver.clone()))?;

        let previous = self.sessions.lock().remove(&spec.thread_id);
        if let Some(previous) = previous {
            let _ = previous.stop().await;
        }

        let thread_id = spec.thread_id.clone();
        let sink = SessionSink::new(thread_id.as_str(), Arc::clone(&self.sink));
        let session = driver.open(spec, sink).await?;
        let session: Arc<dyn Session> = Arc::from(session);
        let opened = Opened {
            thread_id: thread_id.clone(),
            native_session_id: session.native_session_id(),
            model: None,
            pid: session.pid(),
        };
        self.sessions.lock().insert(thread_id, session);
        Ok(opened)
    }

    fn session(&self, thread_id: &str) -> Result<Arc<dyn Session>, PilotError> {
        self.sessions
            .lock()
            .get(thread_id)
            .cloned()
            .ok_or_else(|| PilotError::NoSession(thread_id.to_string()))
    }

    pub async fn prompt(&self, thread_id: &str, input: TurnInput) -> Result<TurnId, PilotError> {
        self.session(thread_id)?.prompt(input).await
    }

    pub async fn interrupt(&self, thread_id: &str) -> Result<(), PilotError> {
        self.session(thread_id)?.interrupt().await
    }

    pub async fn respond(
        &self,
        thread_id: &str,
        request_id: &str,
        answer: RequestAnswer,
    ) -> Result<(), PilotError> {
        self.session(thread_id)?.respond(request_id, answer).await
    }

    pub async fn set_model(
        &self,
        thread_id: &str,
        selection: ModelSelection,
    ) -> Result<SwitchKind, PilotError> {
        self.session(thread_id)?.set_model(selection).await
    }

    pub async fn set_mode(&self, thread_id: &str, mode: ExecMode) -> Result<(), PilotError> {
        self.session(thread_id)?.set_mode(mode).await
    }

    /// Polite stop. The native session stays resumable, which is what makes
    /// auto-sleep safe for a pilot thread.
    pub async fn stop(&self, thread_id: &str) -> Result<(), PilotError> {
        let session = self.sessions.lock().remove(thread_id);
        match session {
            Some(session) => session.stop().await,
            None => Err(PilotError::NoSession(thread_id.to_string())),
        }
    }

    /// Stop everything, for app close.
    ///
    /// Sequential rather than joined: each stop waits out its own grace, and a
    /// hundred children at once is not the shape this ever has.
    pub async fn stop_all(&self) {
        let sessions: Vec<Arc<dyn Session>> =
            self.sessions.lock().drain().map(|(_, session)| session).collect();
        for session in sessions {
            let _ = session.stop().await;
        }
    }

    /// The status of a thread, or `None` when it has no session.
    ///
    /// Synchronous on purpose: the sidebar asks once per pass per thread and
    /// must not be able to block on a child that stopped answering.
    pub fn status(&self, thread_id: &str) -> Option<Status> {
        self.sessions.lock().get(thread_id).map(|session| session.status())
    }

    /// The native session id to write onto `threads.session_id`.
    pub fn native_session_id(&self, thread_id: &str) -> Option<String> {
        self.sessions.lock().get(thread_id).and_then(|session| session.native_session_id())
    }

    /// The pid of a thread's child, the only pid anything may kill.
    pub fn pid(&self, thread_id: &str) -> Option<u32> {
        self.sessions.lock().get(thread_id).and_then(|session| session.pid())
    }

    /// The threads with a live session.
    pub fn open_threads(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.sessions.lock().keys().cloned().collect();
        ids.sort();
        ids
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scripted::{Recorder, Scenario, ScriptedDriver, Step};

    fn scenario() -> Scenario {
        Scenario {
            native_session_id: Some("native-1".into()),
            model: Some("claude-fable-5-1".into()),
            slash_commands: vec!["init".into()],
            steps: vec![Step {
                deltas: vec!["o".into(), "k".into()],
                ..Default::default()
            }],
        }
    }

    fn spec(thread_id: &str) -> OpenSpec {
        OpenSpec {
            thread_id: thread_id.to_string(),
            cwd: std::env::temp_dir(),
            driver: "scripted".to_string(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn a_thread_gets_one_session_and_gives_it_back_on_stop() {
        let recorder = Recorder::new();
        let runtime = Runtime::new(recorder.clone());
        runtime.register(Arc::new(ScriptedDriver::with_scenario(scenario())));

        let opened = runtime.open(spec("t1")).await.expect("open");
        assert_eq!(opened.native_session_id.as_deref(), Some("native-1"));
        assert_eq!(runtime.open_threads(), vec!["t1"]);
        assert_eq!(runtime.status("t1"), Some(Status::Idle));

        runtime.prompt("t1", TurnInput::text("hi")).await.expect("prompt");
        assert_eq!(runtime.status("t1"), Some(Status::Idle), "the turn ran to its end");

        runtime.stop("t1").await.expect("stop");
        assert!(runtime.open_threads().is_empty());
        assert_eq!(runtime.status("t1"), None);
        assert!(recorder.kinds().contains(&"session.exited"));
    }

    #[tokio::test]
    async fn a_call_on_a_thread_with_no_session_says_so() {
        let runtime = Runtime::new(Recorder::new());
        let error = runtime.prompt("nope", TurnInput::text("hi")).await.unwrap_err();
        assert!(matches!(error, PilotError::NoSession(id) if id == "nope"));
    }

    #[tokio::test]
    async fn an_unknown_driver_is_refused_at_open() {
        let runtime = Runtime::new(Recorder::new());
        let mut spec = spec("t1");
        spec.driver = "codex".into();
        let error = runtime.open(spec).await.unwrap_err();
        assert!(matches!(error, PilotError::UnknownDriver(name) if name == "codex"));
    }
}
