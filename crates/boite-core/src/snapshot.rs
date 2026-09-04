//! What Boite looks like right now, in one answer.
//!
//! Written for an agent asked to work out why something is wrong. Everything
//! here was already readable, one call at a time, from four different places,
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
//! the database has three rows and the process table has one is not wrong: it
//! is answering two different questions, so it reports both and names them.

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
    /// What is on the window, when the host has one. `None` on the server,
    /// which has no window, and on a desktop whose webview has never described
    /// itself. See [`crate::screen`], including why a stale `at` here is worth
    /// more than no field at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen: Option<crate::screen::Screen>,
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
///
/// `only` is the project a caller is confined to, `None` being the workspace.
/// Confined, every section is cut to that project on the way out rather than
/// at the caller: a snapshot is one answer built from four reads, and a filter
/// applied afterwards is a filter the next section added is written without.
/// The window is left as it is: what is on the user's screen is the same thing
/// `browser_status` already answers to anyone, deliberately (see
/// `crate::screen`).
pub fn take(
    host: &'static str,
    store: &Store,
    roots: &ProjectRoots,
    live_ptys: Vec<LivePty>,
    screen: Option<crate::screen::Screen>,
    only: Option<&str>,
) -> Snapshot {
    let mut problems = Vec::new();

    let projects: Vec<ProjectLine> = match store.load_projects() {
        Ok(rows) => rows
            .into_iter()
            .filter(|p| only.is_none_or(|id| p.id == id))
            .map(project_line)
            .collect(),
        Err(e) => {
            problems.push(format!("projects could not be read: {e}"));
            Vec::new()
        }
    };

    let threads: Vec<ThreadLine> = match store.load_threads() {
        Ok(rows) => rows
            .into_iter()
            .filter(|t| only.is_none_or(|id| t.project_id == id))
            .map(thread_line)
            .collect(),
        Err(e) => {
            problems.push(format!("threads could not be read: {e}"));
            Vec::new()
        }
    };

    let mut todos: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    match store.load_todos() {
        Ok(rows) => {
            for todo in rows {
                if only.is_some_and(|id| todo.project_id != id) {
                    continue;
                }
                *todos
                    .entry(todo.project_id)
                    .or_default()
                    .entry(todo.state)
                    .or_default() += 1;
            }
        }
        Err(e) => problems.push(format!("todos could not be read: {e}")),
    }

    // A PTY belongs to a thread, so the threads decide which ones are visible.
    // Read off the lines above rather than the rows again: a thread the caller
    // cannot see must not come back as a live process either.
    let live_ptys = match only {
        None => live_ptys,
        Some(_) => {
            let mine: std::collections::HashSet<&str> =
                threads.iter().map(|t| t.id.as_str()).collect();
            live_ptys
                .into_iter()
                .filter(|p| mine.contains(p.thread_id.as_str()))
                .collect()
        }
    };

    Snapshot {
        host,
        version: env!("CARGO_PKG_VERSION"),
        platform: platform(),
        taken_at_ms: now_ms(),
        roots: match only {
            None => roots.registered(),
            Some(_) => registered_for(roots, projects.first()),
        },
        projects,
        threads,
        live_ptys,
        todos,
        screen,
        problems,
    }
}

/// The trust boundary as a confined caller may see it.
///
/// The roots its own project sits under and no others: the list is a list of
/// folders on the user's disk, and the ones holding somebody else's work are
/// not this caller's to read. An empty answer is the honest one for a project
/// nobody registered a root for, and for a caller whose project is not there.
fn registered_for(roots: &ProjectRoots, project: Option<&ProjectLine>) -> Vec<String> {
    let Some(project) = project else {
        return Vec::new();
    };
    let registered = roots.registered();
    let cwd = std::fs::canonicalize(&project.cwd)
        .unwrap_or_else(|_| std::path::PathBuf::from(&project.cwd));
    registered
        .into_iter()
        .filter(|root| cwd.starts_with(std::path::Path::new(root)))
        .collect()
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

    fn project_line_at(cwd: &std::path::Path) -> ProjectLine {
        ProjectLine {
            id: "p".into(),
            name: "p".into(),
            cwd: cwd.to_string_lossy().into_owned(),
            archived: false,
            cwd_exists: cwd.is_dir(),
        }
    }

    #[test]
    fn a_scoped_snapshot_does_not_expose_a_sibling_root_with_the_same_prefix() {
        let dir = scratch("root-prefix");
        let root = dir.join("app");
        let sibling = dir.join("app-two");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let roots = ProjectRoots::default();
        roots.replace(vec![root.to_string_lossy().into_owned()]);

        assert!(registered_for(&roots, Some(&project_line_at(&sibling))).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_scoped_snapshot_includes_the_root_containing_its_project() {
        let dir = scratch("containing-root");
        let root = dir.join("app");
        let project = root.join("nested");
        std::fs::create_dir_all(&project).unwrap();
        let roots = ProjectRoots::default();
        roots.replace(vec![root.to_string_lossy().into_owned()]);
        let registered = roots.registered();

        #[cfg(windows)]
        assert!(registered[0].starts_with(r"\\?\"), "{registered:?}");
        assert_eq!(
            registered_for(&roots, Some(&project_line_at(&project))),
            registered
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_snapshot_says_what_it_could_not_read_instead_of_failing() {
        let dir = scratch("problems");
        let store = Store::open(&dir.join("boite.db")).unwrap();
        // A table the snapshot needs, taken away underneath it.
        store.drop_table_for_test("todos");

        let roots = ProjectRoots::default();
        let snapshot = take("test", &store, &roots, Vec::new(), None, None);
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
                    mcp_server_ids: Some(vec!["codex:unityMCP".into()]),
                },
                1,
            )
            .unwrap();
        assert_eq!(
            store.load_projects().unwrap()[0].mcp_server_ids,
            Some(vec!["codex:unityMCP".into()])
        );

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
            None,
            None,
        );

        assert_eq!(snapshot.projects.len(), 1);
        assert!(snapshot.projects[0].cwd_exists);
        assert_eq!(snapshot.live_ptys.len(), 1);
        assert_eq!(snapshot.roots.len(), 1);
        assert!(snapshot.problems.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn project_at(store: &Store, id: &str, cwd: &std::path::Path) {
        store
            .save_project(
                &Project {
                    id: id.into(),
                    name: id.into(),
                    cwd: cwd.to_string_lossy().to_string(),
                    icon: None,
                    archived: false,
                    git_root: None,
                    worktrees: None,
                    mcp_server_ids: None,
                },
                1,
            )
            .unwrap();
    }

    fn thread_in(store: &Store, id: &str, project_id: &str) {
        store
            .save_thread(&Thread {
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
                runtime: crate::model::default_runtime(),
                pilot_driver: None,
                pilot_instance: None,
                pilot_model: None,
                pilot_options: None,
            })
            .unwrap();
    }

    /// A snapshot taken for one project is a snapshot of that project: the one
    /// next door is not in any of the four sections, and neither is the folder
    /// it lives in.
    #[test]
    fn a_scoped_snapshot_stops_at_its_own_project() {
        let dir = scratch("scoped");
        let mine = dir.join("mine");
        let theirs = dir.join("theirs");
        std::fs::create_dir_all(&mine).unwrap();
        std::fs::create_dir_all(&theirs).unwrap();
        let store = Store::open(&dir.join("boite.db")).unwrap();
        project_at(&store, "p1", &mine);
        project_at(&store, "p2", &theirs);
        thread_in(&store, "t1", "p1");
        thread_in(&store, "t2", "p2");
        store.add_todo("p1", "mine", None, 1).unwrap();
        store.add_todo("p2", "theirs", None, 1).unwrap();

        let roots = ProjectRoots::default();
        roots.replace(vec![
            mine.to_string_lossy().to_string(),
            theirs.to_string_lossy().to_string(),
        ]);
        let live = || {
            vec![
                LivePty { thread_id: "t1".into(), pty_id: "pty-1".into(), child_pid: None },
                LivePty { thread_id: "t2".into(), pty_id: "pty-2".into(), child_pid: None },
            ]
        };

        let scoped = take("test", &store, &roots, live(), None, Some("p1"));
        assert_eq!(
            scoped.projects.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["p1"]
        );
        assert_eq!(
            scoped.threads.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            ["t1"]
        );
        assert_eq!(scoped.todos.keys().collect::<Vec<_>>(), ["p1"]);
        assert_eq!(
            scoped.live_ptys.iter().map(|p| p.thread_id.as_str()).collect::<Vec<_>>(),
            ["t1"]
        );
        assert_eq!(scoped.roots.len(), 1, "{:?}", scoped.roots);
        assert!(!scoped.roots[0].contains("theirs"), "{:?}", scoped.roots);

        // And the workspace-wide answer still holds every one of them.
        let whole = take("test", &store, &roots, live(), None, None);
        assert_eq!(whole.projects.len(), 2);
        assert_eq!(whole.threads.len(), 2);
        assert_eq!(whole.todos.len(), 2);
        assert_eq!(whole.live_ptys.len(), 2);
        assert_eq!(whole.roots.len(), 2);

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
                    mcp_server_ids: None,
                },
                1,
            )
            .unwrap();
        let snapshot = take("test", &store, &ProjectRoots::default(), Vec::new(), None, None);
        assert!(!snapshot.projects[0].cwd_exists);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
