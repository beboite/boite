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

use crate::{Change, Resolution, Workspace};

pub struct Fake {
    pub store: Store,
    pub roots: ProjectRoots,
    pub extra_parents: Vec<String>,
    pub resolution: Resolution,
    /// What `ask` refuses with, when it refuses.
    pub refuse_with: Option<String>,
    pub asked: Mutex<Vec<Value>>,
    pub announced: Mutex<Vec<Change>>,
    pub touched: Mutex<Vec<(String, String)>>,
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
            resolution: Resolution::ThreadThenCwd,
            refuse_with: None,
            asked: Mutex::new(Vec::new()),
            announced: Mutex::new(Vec::new()),
            touched: Mutex::new(Vec::new()),
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

    fn token(&self) -> &str {
        "a-token"
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

    fn resolution(&self) -> Resolution {
        self.resolution
    }

    fn touched(&self, thread_id: &str, surface: &str) {
        self.touched
            .lock()
            .unwrap()
            .push((thread_id.into(), surface.into()));
    }
}
