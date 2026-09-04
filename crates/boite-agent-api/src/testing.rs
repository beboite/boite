//! A workspace with nothing behind it but a real database.
//!
//! The endpoint used to be testable on one side only: the desktop copy carried
//! three test modules and the server copy carried none, so the half that runs
//! headless, the half a remote agent talks to, was the untested one. There is
//! one implementation now, and this is what it is tested against.

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;

use boite_core::model::Project;
use boite_core::scope::ProjectRoots;
use boite_core::store::Store;

use crate::{Change, Workspace};

pub struct Fake {
    pub store: Store,
    pub roots: ProjectRoots,
    pub extra_parents: Vec<String>,
    /// What `ask` refuses with, when it refuses.
    pub refuse_with: Option<String>,
    pub asked: Mutex<Vec<Value>>,
    pub announced: Mutex<Vec<Change>>,
    pub touched: Mutex<Vec<(String, String)>>,
    /// What the window says is on it. `None` is the headless case, which is a
    /// real host rather than an unset field: the server has no window.
    pub screen: Mutex<Option<boite_core::screen::Screen>>,
    /// What the device answers a question with. `None` is a host whose devices
    /// cannot answer, which is the trait's own default.
    pub answer_with: Mutex<Option<Value>>,
    /// PTYs this host still has a process for. Empty is the trait default and
    /// the honest answer for a workspace with none; a wait test that needs a
    /// live worker fills this, because the stored `running` mark is not that.
    pub live_ptys: Mutex<Vec<boite_core::snapshot::LivePty>>,
    /// What the pilot runtime would say about a chat thread, by thread id.
    /// Empty is a host with no session open, which is the trait's own default
    /// and what every terminal-only workspace answers.
    pub pilot_status: Mutex<std::collections::HashMap<String, String>>,
    dir: PathBuf,
}

impl Fake {
    /// A workspace on a scratch database, named after the test using it so a
    /// parallel `cargo test` does not have two of them on one file.
    pub fn new(tag: &str) -> Fake {
        let dir = std::env::temp_dir().join(format!("boite-agent-api-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Fake {
            store: Store::open(&dir.join("boite.db")).unwrap(),
            roots: ProjectRoots::default(),
            extra_parents: Vec::new(),
            refuse_with: None,
            asked: Mutex::new(Vec::new()),
            announced: Mutex::new(Vec::new()),
            touched: Mutex::new(Vec::new()),
            screen: Mutex::new(None),
            answer_with: Mutex::new(None),
            live_ptys: Mutex::new(Vec::new()),
            pilot_status: Mutex::new(std::collections::HashMap::new()),
            dir,
        }
    }

    pub fn with_project(self, id: &str, cwd: &str) -> Fake {
        self.store
            .save_project(
                &Project {
                    id: id.into(),
                    name: id.into(),
                    cwd: cwd.into(),
                    icon: None,
                    archived: false,
                    git_root: None,
                    worktrees: None,
                    mcp_server_ids: None,
                },
                1,
            )
            .unwrap();
        self
    }

    /// A thread row, so a caller can be given a key and a project to answer for.
    pub fn with_thread(self, id: &str, project_id: &str) -> Fake {
        self.store.save_thread(&thread_row(id, project_id)).unwrap();
        self
    }

    /// A thread another one spawned, for anything counting workers.
    pub fn with_child(self, id: &str, project_id: &str, parent: &str) -> Fake {
        let mut thread = thread_row(id, project_id);
        thread.parent_thread_id = Some(parent.into());
        self.store.save_thread(&thread).unwrap();
        self
    }

    /// A chat worker, with what its runtime would say about it.
    ///
    /// The row carries the stored `running` mark a launch leaves behind on
    /// either runtime, so a test proving the pilot branch reads the runtime is
    /// proving it against a row that says the other thing.
    pub fn with_pilot_child(
        self,
        id: &str,
        project_id: &str,
        parent: &str,
        status: Option<&str>,
    ) -> Fake {
        let mut thread = thread_row(id, project_id);
        thread.parent_thread_id = Some(parent.into());
        thread.status = "running".into();
        thread.runtime = boite_core::model::RUNTIME_PILOT.to_string();
        thread.pilot_driver = Some("claude".into());
        self.store.save_thread(&thread).unwrap();
        if let Some(status) = status {
            self.pilot_status
                .lock()
                .unwrap()
                .insert(id.to_string(), status.to_string());
        }
        self
    }

    /// A spawned worker mid-turn, for anything that refuses to touch one.
    pub fn with_busy_child(self, id: &str, project_id: &str, parent: &str) -> Fake {
        let mut thread = thread_row(id, project_id);
        thread.parent_thread_id = Some(parent.into());
        thread.status = "running".into();
        self.store.save_thread(&thread).unwrap();
        self
    }

    /// What a terminal printed, where the PTY reader would have left it.
    ///
    /// Writing one is also what makes this host keep transcripts at all: a
    /// `Fake` nobody wrote one on answers `None`, which is the real behaviour
    /// of a Boite that keeps none rather than an unset field.
    pub fn with_transcript(self, thread_id: &str, text: &str) -> Fake {
        let dir = self.dir.join("transcripts");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{thread_id}.log")), text).unwrap();
        self
    }

    /// The host still has a process for this thread. The stored status is not
    /// that: `load_thread` maps a live mark to `stopped` for restart.
    pub fn with_live_pty(self, thread_id: &str) -> Fake {
        self.live_ptys.lock().unwrap().push(boite_core::snapshot::LivePty {
            thread_id: thread_id.into(),
            pty_id: format!("pty-{thread_id}"),
            child_pid: Some(1),
        });
        self
    }

    pub fn scratch(&self) -> &PathBuf {
        &self.dir
    }
}

fn thread_row(id: &str, project_id: &str) -> boite_core::model::Thread {
    boite_core::model::Thread {
        id: id.into(),
        project_id: project_id.into(),
        pty_id: None,
        label: id.into(),
        title: None,
        cmd: "sh".into(),
        args: Vec::new(),
        icon_key: None,
        icon_color: None,
        session_id: None,
        status: "idle".into(),
        exit_code: None,
        created_at: 1,
        auto_slept: false,
        keep_awake: false,
        worktree_path: None,
        settled_at: None,
        parent_thread_id: None,
        delegation_mode: None,
        delegation_status: None,
        role: None,
        orchestrator_scope: None,
        accept_dispatch: true,
        runtime: boite_core::model::default_runtime(),
        pilot_driver: None,
        pilot_instance: None,
        pilot_model: None,
        pilot_options: None,
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Workspace for Fake {
    fn store(&self) -> &Store {
        &self.store
    }

    fn roots(&self) -> &ProjectRoots {
        &self.roots
    }

    fn secret(&self) -> &str {
        "a-workspace-secret"
    }

    fn extra_project_parents(&self) -> Vec<String> {
        self.extra_parents.clone()
    }

    fn ask(&self, request: Value) -> Result<(), String> {
        if let Some(reason) = &self.refuse_with {
            return Err(reason.clone());
        }
        self.asked.lock().unwrap().push(request);
        Ok(())
    }

    fn ask_settled(
        &self,
        request: Value,
    ) -> Result<tokio::sync::oneshot::Receiver<Value>, String> {
        if let Some(reason) = &self.refuse_with {
            return Err(reason.clone());
        }
        self.asked.lock().unwrap().push(request);
        match self.answer_with.lock().unwrap().clone() {
            Some(answer) => {
                let (tx, rx) = tokio::sync::oneshot::channel();
                let _ = tx.send(answer);
                Ok(rx)
            }
            None => Err(crate::NOBODY_TO_CARRY_IT_OUT.to_string()),
        }
    }

    fn announce(&self, change: Change) {
        self.announced.lock().unwrap().push(change);
    }

    fn transcripts_dir(&self) -> Option<PathBuf> {
        let dir = self.dir.join("transcripts");
        dir.is_dir().then_some(dir)
    }

    fn on_screen(&self) -> Option<boite_core::screen::Screen> {
        self.screen.lock().unwrap().clone()
    }

    fn live_ptys(&self) -> Vec<boite_core::snapshot::LivePty> {
        self.live_ptys.lock().unwrap().clone()
    }

    fn pilot_status(&self, thread_id: &str) -> Option<String> {
        self.pilot_status.lock().unwrap().get(thread_id).cloned()
    }

    fn touched(&self, thread_id: &str, surface: &str) {
        self.touched
            .lock()
            .unwrap()
            .push((thread_id.into(), surface.into()));
    }

    fn ask_for_answer(
        &self,
        request: Value,
    ) -> Result<tokio::sync::oneshot::Receiver<Value>, String> {
        let scripted = self.answer_with.lock().unwrap().clone();
        match scripted {
            Some(answer) => {
                self.asked.lock().unwrap().push(request);
                let (tx, rx) = tokio::sync::oneshot::channel();
                let _ = tx.send(answer);
                Ok(rx)
            }
            None => Err(crate::DEVICE_CANNOT_ANSWER.to_string()),
        }
    }
}
