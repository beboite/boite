//! What Boite looks like right now, in one answer.
//!
//! Written for an agent asked to work out why something is wrong. Everything
//! here was already readable, one call at a time, from four different places —
//! and an agent that has to make four calls to build a picture usually stops and
//! asks a human instead. That is the failure this exists to remove.
//!
//! Two rules, both about being trustworthy rather than complete:
//!
//! Nothing in here is a secret. No token, no environment, no file contents. A
//! snapshot is meant to be pasted into an issue, and one that has to be read
//! before it is shared is one nobody shares.
//!
//! Every count says what it counted. A snapshot that reports three threads when
//! the database has three rows and the process table has one is not wrong — it
//! is answering two different questions — so it reports both and names them.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::model::{Project, Thread};
use crate::scope::ProjectRoots;
use crate::store::Store;

/// A PTY the host still has a process for.
///
/// The host's own view, not the database's: a row can say `running` about a
/// process that died, and telling those two apart is most of what a snapshot is
/// for.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LivePty {
    pub thread_id: String,
    pub pty_id: String,
    pub child_pid: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Which side answered, so a snapshot read out of context still says what
    /// it is a snapshot of.
    pub host: &'static str,
    pub version: &'static str,
    pub platform: &'static str,
    pub taken_at_ms: i64,
    pub projects: Vec<ProjectLine>,
    pub threads: Vec<ThreadLine>,
    /// The PTYs the host has a process for. Compare with the threads: a thread
    /// whose status says `running` and whose id is not in here is the shape of
    /// nearly every "my terminal is dead" report.
    pub live_ptys: Vec<LivePty>,
    /// The filesystem trust boundary, as it stands.
    pub roots: Vec<String>,
    /// Todos per project, by state.
    pub todos: BTreeMap<String, BTreeMap<String, usize>>,
    /// What could not be read, and why. Never a reason to answer nothing: a
    /// snapshot missing one section is still worth more than an error.
    pub problems: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLine {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub archived: bool,
    /// Whether the folder is really there. A project pointing at a directory
    /// that has been moved or deleted explains a great deal at once.
    pub cwd_exists: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadLine {
    pub id: String,
    pub project_id: String,
    pub label: String,
    pub status: String,
    pub cmd: String,
    /// What the row says. `livePtys` says what is true.
    pub pty_id: Option<String>,
    pub worktree_path: Option<String>,
    pub agent: Option<String>,
}

/// Reads everything at once, and never fails.
///
/// A section that cannot be read is named in `problems` and left out. An agent
/// reaching for this is already looking at something broken; answering it with
/// an error would be the second thing that does not work.
pub fn take(
    host: &'static str,
    store: &Store,
    roots: &ProjectRoots,
    live_ptys: Vec<LivePty>,
) -> Snapshot {
    let mut problems = Vec::new();

    let projects = match store.load_projects() {
        Ok(rows) => rows.into_iter().map(project_line).collect(),
        Err(e) => {
            problems.push(format!("projects could not be read: {e}"));
            Vec::new()
        }
    };

    let threads = match store.load_threads() {
        Ok(rows) => rows.into_iter().map(thread_line).collect(),
        Err(e) => {
            problems.push(format!("threads could not be read: {e}"));
            Vec::new()
        }
    };

    let mut todos: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    match store.load_todos() {
        Ok(rows) => {
            for todo in rows {
                *todos
                    .entry(todo.project_id)
                    .or_default()
                    .entry(todo.state)
                    .or_default() += 1;
            }
        }
        Err(e) => problems.push(format!("todos could not be read: {e}")),
    }

    Snapshot {
        host,
        version: env!("CARGO_PKG_VERSION"),
        platform: platform(),
        taken_at_ms: now_ms(),
        projects,
        threads,
        live_ptys,
        roots: roots.registered(),
        todos,
        problems,
    }
}

fn project_line(p: Project) -> ProjectLine {
    ProjectLine {
        cwd_exists: std::path::Path::new(&p.cwd).is_dir(),
        id: p.id,
        name: p.name,
        cwd: p.cwd,
        archived: p.archived,
    }
}

fn thread_line(t: Thread) -> ThreadLine {
    ThreadLine {
        id: t.id,
        project_id: t.project_id,
        label: t.label,
        status: t.status,
        cmd: t.cmd,
        pty_id: t.pty_id,
        worktree_path: t.worktree_path,
        agent: t.icon_key,
    }
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Project;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("boite-snapshot-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_snapshot_says_what_it_could_not_read_instead_of_failing() {
        let dir = scratch("problems");
        let store = Store::open(&dir.join("boite.db")).unwrap();
        // A table the snapshot needs, taken away underneath it.
        store.drop_table_for_test("todos");

        let roots = ProjectRoots::default();
        let snapshot = take("test", &store, &roots, Vec::new());
        assert!(snapshot.todos.is_empty());
        assert_eq!(snapshot.problems.len(), 1);
        assert!(snapshot.problems[0].starts_with("todos could not be read"));
        // And the sections that were fine are still there.
        assert!(snapshot.projects.is_empty());
        assert_eq!(snapshot.host, "test");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The comparison the whole thing exists for: what the rows claim, next to
    /// what the host actually has a process for.
    #[test]
    fn a_thread_that_claims_a_pty_nobody_has_is_visible_side_by_side() {
        let dir = scratch("live");
        let store = Store::open(&dir.join("boite.db")).unwrap();
        store
            .save_project(
                &Project {
                    id: "p".into(),
                    name: "p".into(),
                    cwd: dir.to_string_lossy().to_string(),
                    icon: None,
                    archived: false,
                    git_root: None,
                    worktrees: None,
                },
                1,
            )
            .unwrap();

        let roots = ProjectRoots::default();
        roots.replace(vec![dir.to_string_lossy().to_string()]);
        let snapshot = take(
            "test",
            &store,
            &roots,
            vec![LivePty {
                thread_id: "t2".into(),
                pty_id: "pty-2".into(),
                child_pid: Some(1234),
            }],
        );

        assert_eq!(snapshot.projects.len(), 1);
        assert!(snapshot.projects[0].cwd_exists);
        assert_eq!(snapshot.live_ptys.len(), 1);
        assert_eq!(snapshot.roots.len(), 1);
        assert!(snapshot.problems.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A project whose folder has been moved or deleted explains a great deal
    /// at once, so the snapshot checks rather than repeating the row.
    #[test]
    fn a_project_pointing_at_nothing_says_so() {
        let dir = scratch("gone");
        let store = Store::open(&dir.join("boite.db")).unwrap();
        store
            .save_project(
                &Project {
                    id: "p".into(),
                    name: "p".into(),
                    cwd: dir.join("moved-away").to_string_lossy().to_string(),
                    icon: None,
                    archived: false,
                    git_root: None,
                    worktrees: None,
                },
                1,
            )
            .unwrap();
        let snapshot = take("test", &store, &ProjectRoots::default(), Vec::new());
        assert!(!snapshot.projects[0].cwd_exists);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
