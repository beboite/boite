//! The git and worktree surface, as commands.
//!
//! Twenty-seven capabilities that were written out twice, once as a Tauri
//! command and once as a WebSocket arm, with the trust boundary re-applied by
//! hand in each copy. They are one list now. What is left in the two front doors
//! is decoding and, on the server, the envelope the protocol wraps an answer in.
//!
//! Worktrees live here rather than in a module of their own because they are git
//! worktrees: every one of them is a path inside a repository, checked the same
//! way, and splitting them would put the same boundary in two files again.

use std::path::Path;

use serde_json::{json, Value};

use super::{
    bool_param, opt_str_param, str_list, str_param, u32_param, value_of, Command, Host, Ready, Wire,
};
use crate::capability::Capability;
use crate::git;

/// Every method in this domain, in the order they appear below.
///
/// The list a test walks to prove that each one decodes, names itself back and
/// refuses to prepare outside the registered roots. A new command belongs here
/// the moment it exists; nothing else in the file needs to know about it.
pub const ALL_METHODS: &[&str] = &[
    "git.repoInfo",
    "git.findRepos",
    "git.branches",
    "git.switchBranch",
    "git.status",
    "git.changedPaths",
    "git.log",
    "git.commitState",
    "git.pullRequest",
    "git.stage",
    "git.unstage",
    "git.discard",
    "git.commit",
    "git.fetch",
    "git.push",
    "git.pull",
    "git.init",
    "git.fileVersions",
    "worktree.open",
    "worktree.warm",
    "worktree.migrate",
    "worktree.adopt",
    "worktree.list",
    "worktree.claim",
    "worktree.reserve",
    "worktree.hold",
    "worktree.remove",
    "worktree.sizes",
];

#[derive(Debug, Clone, PartialEq)]
pub enum Git {
    RepoInfo {
        path: String,
    },
    FindRepos {
        path: String,
    },
    Branches {
        path: String,
    },
    SwitchBranch {
        path: String,
        name: String,
        create: bool,
        stash: bool,
    },
    Status {
        path: String,
    },
    ChangedPaths {
        path: String,
    },
    Log {
        path: String,
        limit: u32,
        skip: u32,
    },
    /// What the repository says about a commit an agent claimed. A sha is not a
    /// path, but the repository it is read in is.
    CommitState {
        path: String,
        sha: String,
    },
    /// What `gh` says about a branch: a pull request, none, nothing it can
    /// answer, or a refusal worth passing on.
    PullRequest {
        path: String,
        branch: String,
    },
    Stage {
        path: String,
        files: Vec<String>,
    },
    Unstage {
        path: String,
        files: Vec<String>,
    },
    Discard {
        path: String,
        files: Vec<String>,
        untracked: Vec<String>,
    },
    Commit {
        path: String,
        message: String,
    },
    Fetch {
        path: String,
    },
    Push {
        path: String,
    },
    Pull {
        path: String,
    },
    Init {
        path: String,
    },
    FileVersions {
        path: String,
        file: String,
        /// Renamed files live under their old name in HEAD.
        head_file: Option<String>,
    },

    /// Opens a detached worktree for a thread, or answers that this repository
    /// is not one to open a worktree in.
    ///
    /// The base is derived from the repository, never taken from the caller, so
    /// nothing here widens the filesystem boundary.
    WorktreeOpen {
        repo: String,
        thread_id: String,
    },
    /// Makes sure a project has a worktree standing by. Fire and forget: the
    /// answer says the warming started, never that it finished, and a project
    /// that cannot have one is not a failure to report.
    WorktreeWarm {
        repo: String,
    },
    /// Moves a worktree left over from the old layout into its project.
    ///
    /// Scoped on both ends: the repository is a registered root, and the
    /// destination is computed from it rather than taken from the caller. The
    /// source has to be one the host's own earlier layout left behind, which is
    /// the check [`Git::prepare`] needs a host for.
    WorktreeMigrate {
        repo: String,
        thread_id: String,
        from: String,
    },
    /// Hands back the worktree a thread already owns but has no path to. Derived
    /// from the repository and the id, so there is no path to point anywhere.
    WorktreeAdopt {
        repo: String,
        thread_id: String,
    },
    /// Every worktree of a repository, read from the repository itself. The
    /// paths come back from git rather than going in.
    WorktreeList {
        repo: String,
    },
    WorktreeClaim {
        path: String,
        name: String,
    },
    WorktreeReserve {
        path: String,
        name: String,
    },
    WorktreeHold {
        path: String,
    },
    WorktreeRemove {
        repo: String,
        path: String,
        force: bool,
    },
    /// What these worktrees take on disk, so a panel offering to reclaim space
    /// can say how much. Apart from the listing because walking the files costs
    /// far more than reading git's own answer, and nothing that only draws the
    /// list has to pay for it.
    WorktreeSizes {
        paths: Vec<String>,
    },
}

impl Git {
    pub(super) fn decode(method: &str, params: &Value) -> Result<Self, String> {
        let path = || str_param(params, "path");
        let repo = || str_param(params, "repo");
        let thread_id = || str_param(params, "threadId");
        Ok(match method {
            "git.repoInfo" => Git::RepoInfo { path: path()? },
            "git.findRepos" => Git::FindRepos { path: path()? },
            "git.branches" => Git::Branches { path: path()? },
            "git.switchBranch" => Git::SwitchBranch {
                path: path()?,
                name: str_param(params, "name")?,
                create: bool_param(params, "create", false),
                stash: bool_param(params, "stash", false),
            },
            "git.status" => Git::Status { path: path()? },
            "git.changedPaths" => Git::ChangedPaths { path: path()? },
            "git.log" => Git::Log {
                path: path()?,
                limit: u32_param(params, "limit", 100),
                skip: u32_param(params, "skip", 0),
            },
            "git.commitState" => Git::CommitState {
                path: path()?,
                sha: str_param(params, "sha")?,
            },
            "git.pullRequest" => Git::PullRequest {
                path: path()?,
                branch: str_param(params, "branch")?,
            },
            "git.stage" => Git::Stage {
                path: path()?,
                files: str_list(params, "files"),
            },
            "git.unstage" => Git::Unstage {
                path: path()?,
                files: str_list(params, "files"),
            },
            "git.discard" => Git::Discard {
                path: path()?,
                files: str_list(params, "files"),
                untracked: str_list(params, "untracked"),
            },
            "git.commit" => Git::Commit {
                path: path()?,
                message: str_param(params, "message")?,
            },
            "git.fetch" => Git::Fetch { path: path()? },
            "git.push" => Git::Push { path: path()? },
            "git.pull" => Git::Pull { path: path()? },
            "git.init" => Git::Init { path: path()? },
            "git.fileVersions" => Git::FileVersions {
                path: path()?,
                file: str_param(params, "file")?,
                head_file: opt_str_param(params, "headFile"),
            },
            "worktree.open" => Git::WorktreeOpen {
                repo: repo()?,
                thread_id: thread_id()?,
            },
            "worktree.warm" => Git::WorktreeWarm { repo: repo()? },
            "worktree.migrate" => Git::WorktreeMigrate {
                repo: repo()?,
                thread_id: thread_id()?,
                from: str_param(params, "from")?,
            },
            "worktree.adopt" => Git::WorktreeAdopt {
                repo: repo()?,
                thread_id: thread_id()?,
            },
            "worktree.list" => Git::WorktreeList { repo: repo()? },
            "worktree.claim" => Git::WorktreeClaim {
                path: path()?,
                name: str_param(params, "name")?,
            },
            "worktree.reserve" => Git::WorktreeReserve {
                path: path()?,
                name: str_param(params, "name")?,
            },
            "worktree.hold" => Git::WorktreeHold { path: path()? },
            "worktree.remove" => Git::WorktreeRemove {
                repo: repo()?,
                path: path()?,
                force: bool_param(params, "force", false),
            },
            "worktree.sizes" => Git::WorktreeSizes {
                paths: str_list(params, "paths"),
            },
            other => return Err(format!("unknown method: {other}")),
        })
    }

    pub(super) fn name(&self) -> &'static str {
        match self {
            Git::RepoInfo { .. } => "git.repoInfo",
            Git::FindRepos { .. } => "git.findRepos",
            Git::Branches { .. } => "git.branches",
            Git::SwitchBranch { .. } => "git.switchBranch",
            Git::Status { .. } => "git.status",
            Git::ChangedPaths { .. } => "git.changedPaths",
            Git::Log { .. } => "git.log",
            Git::CommitState { .. } => "git.commitState",
            Git::PullRequest { .. } => "git.pullRequest",
            Git::Stage { .. } => "git.stage",
            Git::Unstage { .. } => "git.unstage",
            Git::Discard { .. } => "git.discard",
            Git::Commit { .. } => "git.commit",
            Git::Fetch { .. } => "git.fetch",
            Git::Push { .. } => "git.push",
            Git::Pull { .. } => "git.pull",
            Git::Init { .. } => "git.init",
            Git::FileVersions { .. } => "git.fileVersions",
            Git::WorktreeOpen { .. } => "worktree.open",
            Git::WorktreeWarm { .. } => "worktree.warm",
            Git::WorktreeMigrate { .. } => "worktree.migrate",
            Git::WorktreeAdopt { .. } => "worktree.adopt",
            Git::WorktreeList { .. } => "worktree.list",
            Git::WorktreeClaim { .. } => "worktree.claim",
            Git::WorktreeReserve { .. } => "worktree.reserve",
            Git::WorktreeHold { .. } => "worktree.hold",
            Git::WorktreeRemove { .. } => "worktree.remove",
            Git::WorktreeSizes { .. } => "worktree.sizes",
        }
    }

    pub(super) fn wire(&self) -> Wire {
        match self {
            Git::RepoInfo { .. }
            | Git::SwitchBranch { .. }
            | Git::FileVersions { .. }
            | Git::WorktreeMigrate { .. }
            | Git::WorktreeHold { .. } => Wire::Bare,

            Git::FindRepos { .. } => Wire::Key("repos"),
            Git::Branches { .. } => Wire::Key("branches"),
            Git::Status { .. } => Wire::Key("entries"),
            Git::ChangedPaths { .. } => Wire::Key("paths"),
            Git::Log { .. } => Wire::Key("commits"),
            Git::CommitState { .. } => Wire::Key("state"),
            Git::PullRequest { .. } => Wire::Key("lookup"),
            Git::Commit { .. } => Wire::Key("sha"),
            Git::WorktreeOpen { .. } | Git::WorktreeAdopt { .. } => Wire::Key("path"),
            Git::WorktreeList { .. } => Wire::Key("worktrees"),
            Git::WorktreeSizes { .. } => Wire::Key("sizes"),

            Git::Stage { .. }
            | Git::Unstage { .. }
            | Git::Discard { .. }
            | Git::Fetch { .. }
            | Git::Push { .. }
            | Git::Pull { .. }
            | Git::Init { .. }
            | Git::WorktreeWarm { .. }
            | Git::WorktreeClaim { .. }
            | Git::WorktreeReserve { .. }
            | Git::WorktreeRemove { .. } => Wire::Ok,
        }
    }

    /// What a caller needs to hold to ask for this.
    ///
    /// Every one of these stays inside the repository it names, so nothing in
    /// this domain reaches [`Capability::MutateAcross`]. `worktree.remove` is
    /// the closest and is still not one: it deletes a worktree of the repository
    /// it was given, and the boundary already had to allow both paths.
    pub(super) fn capability(&self) -> Capability {
        match self {
            Git::RepoInfo { .. }
            | Git::FindRepos { .. }
            | Git::Branches { .. }
            | Git::Status { .. }
            | Git::ChangedPaths { .. }
            | Git::Log { .. }
            | Git::CommitState { .. }
            | Git::PullRequest { .. }
            | Git::FileVersions { .. }
            | Git::WorktreeList { .. }
            | Git::WorktreeSizes { .. }
            | Git::WorktreeHold { .. } => Capability::ReadProject,

            Git::SwitchBranch { .. }
            | Git::Stage { .. }
            | Git::Unstage { .. }
            | Git::Discard { .. }
            | Git::Commit { .. }
            | Git::Fetch { .. }
            | Git::Push { .. }
            | Git::Pull { .. }
            | Git::Init { .. }
            | Git::WorktreeOpen { .. }
            | Git::WorktreeWarm { .. }
            | Git::WorktreeMigrate { .. }
            | Git::WorktreeAdopt { .. }
            | Git::WorktreeClaim { .. }
            | Git::WorktreeReserve { .. }
            | Git::WorktreeRemove { .. } => Capability::MutateProject,
        }
    }

    /// Every path this command took from its caller.
    ///
    /// The whole trust boundary for this domain, in one list. A command that
    /// derives a path instead of accepting one contributes nothing here, which
    /// is why `worktree.open` and `worktree.adopt` only offer their repository:
    /// their destination is computed from it.
    fn caller_paths(&self) -> Vec<&str> {
        match self {
            Git::RepoInfo { path }
            | Git::FindRepos { path }
            | Git::Branches { path }
            | Git::SwitchBranch { path, .. }
            | Git::Status { path }
            | Git::ChangedPaths { path }
            | Git::Log { path, .. }
            | Git::CommitState { path, .. }
            | Git::PullRequest { path, .. }
            | Git::Stage { path, .. }
            | Git::Unstage { path, .. }
            | Git::Discard { path, .. }
            | Git::Commit { path, .. }
            | Git::Fetch { path }
            | Git::Push { path }
            | Git::Pull { path }
            | Git::Init { path }
            | Git::FileVersions { path, .. }
            | Git::WorktreeClaim { path, .. }
            | Git::WorktreeReserve { path, .. }
            | Git::WorktreeHold { path } => vec![path],

            Git::WorktreeOpen { repo, .. }
            | Git::WorktreeWarm { repo }
            | Git::WorktreeMigrate { repo, .. }
            | Git::WorktreeAdopt { repo, .. }
            | Git::WorktreeList { repo } => vec![repo],

            Git::WorktreeRemove { repo, path, .. } => vec![repo, path],

            // Every one of them, for the same reason `worktree.remove` offers
            // both of its own: a list is not a weaker claim than a single path.
            Git::WorktreeSizes { paths } => paths.iter().map(String::as_str).collect(),
        }
    }

    pub(super) fn prepare(self, host: &dyn Host) -> Result<Ready, String> {
        for path in self.caller_paths() {
            host.roots().ensure_allowed(path)?;
        }
        // The one command with something left for the host to say. A source
        // outside the layout this host actually left behind is not refused, it
        // is left where it is: the caller asked whether an old worktree needs
        // moving, and the answer is no.
        if let Git::WorktreeMigrate { from, .. } = &self {
            let left_behind = host
                .legacy_worktree_base()
                .is_some_and(|base| Path::new(from).starts_with(base));
            if !left_behind {
                return Ok(Ready::Settled(json!({ "path": null, "gone": false })));
            }
        }
        Ok(Ready::Work(Command::Git(self)))
    }

    pub(super) fn run(self) -> Result<Value, String> {
        Ok(match self {
            Git::RepoInfo { path } => value_of(git::repo_info_blocking(&path)?),
            Git::FindRepos { path } => value_of(git::find_repos_blocking(&path, 3)?),
            Git::Branches { path } => value_of(git::branches_blocking(&path)?),
            Git::SwitchBranch {
                path,
                name,
                create,
                stash,
            } => value_of(git::switch_branch_blocking(&path, &name, create, stash)?),
            Git::Status { path } => value_of(git::status_blocking(&path)?),
            Git::ChangedPaths { path } => value_of(git::changed_paths_blocking(&path)?),
            Git::Log { path, limit, skip } => value_of(git::log_blocking(&path, limit, skip)?),
            Git::CommitState { path, sha } => value_of(git::commit_state_blocking(&path, &sha)),
            Git::PullRequest { path, branch } => {
                value_of(git::pull_request_for_branch_blocking(&path, &branch))
            }
            Git::Stage { path, files } => {
                git::run_files(&path, "add", &files, true)?;
                Value::Null
            }
            Git::Unstage { path, files } => {
                git::unstage_blocking(&path, files)?;
                Value::Null
            }
            Git::Discard {
                path,
                files,
                untracked,
            } => {
                git::discard_blocking(&path, files, untracked)?;
                Value::Null
            }
            Git::Commit { path, message } => value_of(git::commit_blocking(&path, &message)?),
            Git::Fetch { path } => {
                git::fetch_blocking(&path)?;
                Value::Null
            }
            Git::Push { path } => {
                git::push_blocking(&path)?;
                Value::Null
            }
            Git::Pull { path } => {
                git::pull_blocking(&path)?;
                Value::Null
            }
            Git::Init { path } => {
                git::init_blocking(&path)?;
                Value::Null
            }
            Git::FileVersions {
                path,
                file,
                head_file,
            } => value_of(git::file_versions_blocking(
                &path,
                &file,
                head_file.as_deref(),
            )?),

            Git::WorktreeOpen { repo, thread_id } => {
                let base = worktree_base(&repo);
                value_of(git::open_worktree_if_eligible_blocking(
                    &repo, &base, &thread_id,
                )?)
            }
            Git::WorktreeWarm { repo } => {
                let base = worktree_base(&repo);
                // Fire and forget, and that includes the failure: a project that
                // cannot have a spare is not something to report to the caller
                // that only asked for the warming to start.
                if let Err(err) = git::warm_worktree_pool_blocking(&repo, &base) {
                    eprintln!("[boite/worktree] warm failed: {err}");
                }
                Value::Null
            }
            Git::WorktreeMigrate {
                repo,
                thread_id,
                from,
            } => {
                let base = git::worktree_base_for(Path::new(&repo));
                let to = git::scoped_dir_for(&base, &thread_id)
                    .to_string_lossy()
                    .to_string();
                let landed = git::migrate_worktree_blocking(&repo, &from, &to)?;
                // No path and nothing left to move: the directory is gone, and
                // the thread has to stop pointing at it rather than retry every
                // start.
                let gone = landed.is_none();
                json!({ "path": landed, "gone": gone })
            }
            Git::WorktreeAdopt { repo, thread_id } => {
                value_of(git::adopt_worktree_blocking(&repo, &thread_id))
            }
            Git::WorktreeList { repo } => value_of(git::list_worktrees_blocking(&repo)?),
            Git::WorktreeClaim { path, name } => {
                git::claim_worktree_branch_blocking(&path, &name)?;
                Value::Null
            }
            Git::WorktreeReserve { path, name } => {
                git::reserve_worktree_branch_blocking(&path, &name)?;
                Value::Null
            }
            Git::WorktreeHold { path } => value_of(git::worktree_hold_blocking(&path)?),
            Git::WorktreeRemove { repo, path, force } => {
                git::remove_worktree_blocking(&repo, &path, force)?;
                Value::Null
            }
            Git::WorktreeSizes { paths } => value_of(git::worktree_sizes_blocking(&paths)),
        })
    }
}

fn worktree_base(repo: &str) -> String {
    git::worktree_base_for(Path::new(repo))
        .to_string_lossy()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::Grant;
    use crate::command::Scoped;
    use crate::scope::ProjectRoots;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "boite-command-{}-{}-{}",
            name,
            std::process::id(),
            ALL_METHODS.len()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    /// Everything any command in this domain reads, so one object decodes all of
    /// them. Params a command does not use are ignored, which is what lets the
    /// tests below walk the whole surface.
    fn every_param(path: &str) -> Value {
        json!({
            "path": path,
            "repo": path,
            "from": path,
            "threadId": "thread-1",
            "name": "a-branch",
            "sha": "0123456789abcdef",
            "branch": "a-branch",
            "message": "a message",
            "file": "a.txt",
            "headFile": "b.txt",
            "files": ["a.txt"],
            "untracked": ["b.txt"],
            "paths": [path],
            "limit": 10,
            "skip": 0,
            "create": false,
            "stash": false,
            "force": false,
        })
    }

    #[test]
    fn every_method_decodes_and_names_itself_back() {
        let params = every_param("/tmp/whatever");
        for method in ALL_METHODS {
            let command = Command::decode(method, &params)
                .unwrap_or_else(|err| panic!("{method} did not decode: {err}"));
            assert_eq!(command.name(), *method);
        }
    }

    /// The reason this module exists in a shape rather than as a pile of
    /// functions: no command in the surface can be prepared for a path outside
    /// the registered roots, and adding one to `ALL_METHODS` puts it under the
    /// same proof. The two front doors used to re-apply this check by hand, once
    /// per command, twice.
    #[test]
    fn no_command_prepares_outside_the_registered_roots() {
        let outside = scratch("outside");
        let params = every_param(outside.to_str().unwrap());
        let roots = ProjectRoots::default();
        roots.replace(vec![scratch("root").to_string_lossy().to_string()]);
        let host = Scoped::new(&roots);

        for method in ALL_METHODS {
            let command = Command::decode(method, &params).unwrap();
            let err = command
                .prepare(&host, Grant::Local)
                .err()
                .unwrap_or_else(|| panic!("{method} accepted a path outside the roots"));
            assert!(
                err.contains("outside registered project roots"),
                "{method} refused for the wrong reason: {err}"
            );
        }
    }

    /// `worktree.remove` takes two paths and both are the caller's. A boundary
    /// applied to the first one only would let a repository inside the roots
    /// name a worktree anywhere on the disk.
    #[test]
    fn a_second_path_is_checked_like_the_first() {
        let root = scratch("remove-root");
        let outside = scratch("remove-outside");
        let roots = ProjectRoots::default();
        roots.replace(vec![root.to_string_lossy().to_string()]);
        let host = Scoped::new(&roots);

        let command = Command::decode(
            "worktree.remove",
            &json!({ "repo": root.to_str().unwrap(), "path": outside.to_str().unwrap() }),
        )
        .unwrap();
        assert!(command.prepare(&host, Grant::Local).is_err());
    }

    /// A worktree that never lived under this host's old layout is left where it
    /// is, and the caller is told so without anything being run. The host with
    /// no legacy base at all is the same answer: a fresh install has nothing to
    /// migrate.
    #[test]
    fn a_worktree_outside_the_old_layout_is_left_alone() {
        let root = scratch("migrate-root");
        let roots = ProjectRoots::default();
        roots.replace(vec![root.to_string_lossy().to_string()]);
        let params = json!({
            "repo": root.to_str().unwrap(),
            "threadId": "thread-1",
            "from": root.join("somewhere").to_str().unwrap(),
        });

        for base in [None, Some(scratch("migrate-legacy"))] {
            let host = Scoped::new(&roots).with_legacy_worktree_base(base);
            let ready = Command::decode("worktree.migrate", &params)
                .unwrap()
                .prepare(&host, Grant::Local)
                .unwrap();
            match ready {
                Ready::Settled(value) => {
                    assert_eq!(value, json!({ "path": null, "gone": false }))
                }
                other => panic!("a worktree outside the old layout was moved: {other:?}"),
            }
        }
    }

    /// The shape a remote client reads. These keys are the WebSocket protocol,
    /// so a rename here is a frontend that silently reads `undefined` — pinned
    /// rather than left to whoever edits the enum next.
    #[test]
    fn the_protocol_envelopes_are_what_shipped() {
        let params = every_param("/tmp/whatever");
        let expected: &[(&str, Wire)] = &[
            ("git.repoInfo", Wire::Bare),
            ("git.findRepos", Wire::Key("repos")),
            ("git.branches", Wire::Key("branches")),
            ("git.switchBranch", Wire::Bare),
            ("git.status", Wire::Key("entries")),
            ("git.changedPaths", Wire::Key("paths")),
            ("git.log", Wire::Key("commits")),
            ("git.commitState", Wire::Key("state")),
            ("git.pullRequest", Wire::Key("lookup")),
            ("git.stage", Wire::Ok),
            ("git.unstage", Wire::Ok),
            ("git.discard", Wire::Ok),
            ("git.commit", Wire::Key("sha")),
            ("git.fetch", Wire::Ok),
            ("git.push", Wire::Ok),
            ("git.pull", Wire::Ok),
            ("git.init", Wire::Ok),
            ("git.fileVersions", Wire::Bare),
            ("worktree.open", Wire::Key("path")),
            ("worktree.warm", Wire::Ok),
            ("worktree.migrate", Wire::Bare),
            ("worktree.adopt", Wire::Key("path")),
            ("worktree.list", Wire::Key("worktrees")),
            ("worktree.claim", Wire::Ok),
            ("worktree.reserve", Wire::Ok),
            ("worktree.hold", Wire::Bare),
            ("worktree.remove", Wire::Ok),
            ("worktree.sizes", Wire::Key("sizes")),
        ];
        assert_eq!(expected.len(), ALL_METHODS.len());
        for (method, wire) in expected {
            let command = Command::decode(method, &params).unwrap();
            assert_eq!(command.wire(), *wire, "{method}");
        }
        assert_eq!(
            Wire::Key("repos").wrap(json!(["a"])),
            json!({ "repos": ["a"] })
        );
        assert_eq!(Wire::Ok.wrap(Value::Null), json!({ "ok": true }));
        assert_eq!(Wire::Bare.wrap(json!(1)), json!(1));
    }

    #[test]
    fn a_method_nobody_serves_is_refused_by_name() {
        let err = Command::decode("git.rewriteHistory", &json!({ "path": "/tmp" })).unwrap_err();
        assert_eq!(err, "unknown method: git.rewriteHistory");
        assert_eq!(
            Command::decode("nonsense", &json!({})).unwrap_err(),
            "unknown method: nonsense"
        );
    }

    #[test]
    fn a_missing_parameter_names_itself() {
        let err = Command::decode("git.commit", &json!({ "path": "/tmp" })).unwrap_err();
        assert_eq!(err, "missing param: message");
    }
}
