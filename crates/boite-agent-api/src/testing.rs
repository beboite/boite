//! A workspace with nothing behind it but a real database.
//!
//! The endpoint used to be testable on one side only: the desktop copy carried
//! three test modules and the server copy carried none, so the half that runs
//! headless — the half a remote agent talks to — was the untested one. There is
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
                },
                1,
            )
            .unwrap();
        self
    }

    /// A thread row, so a caller can be given a key and a project to answer for.
    pub fn with_thread(self, id: &str, project_id: &str) -> Fake {
        self.store
            .save_thread(&boite_core::model::Thread {
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
                pin_order: None,
                settled_at: None,
                snoozed_until: None,
            })
            .unwrap();
        self
    }

    pub fn scratch(&self) -> &PathBuf {
        &self.dir
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

    fn announce(&self, change: Change) {
        self.announced.lock().unwrap().push(change);
    }

    fn on_screen(&self) -> Option<boite_core::screen::Screen> {
        self.screen.lock().unwrap().clone()
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
