//! Per-turn checkpoints, as commands.
//!
//! Its own domain rather than six more variants on [`super::Git`], because the
//! only thing these share with the git surface is the binary they shell out to:
//! nothing here reads a branch, a status or a log, and every one of them is
//! keyed by a thread rather than by a file. Worktrees live on `Git` for the
//! opposite reason — they *are* the repository's own paths.

use serde_json::Value;

use super::{bool_param, str_param, value_of, Command, Host, Ready, Wire};
use crate::capability::Capability;
use crate::checkpoint::{self, Edge};

/// Every method in this domain, in the order they appear below.
pub const ALL_METHODS: &[&str] = &[
    "checkpoint.capture",
    "checkpoint.list",
    "checkpoint.diff",
    "checkpoint.fileVersions",
    "checkpoint.restore",
    "checkpoint.forget",
];

#[derive(Debug, Clone, PartialEq)]
pub enum Checkpoints {
    /// Writes what the tree looks like right now to one end of a turn.
    ///
    /// Answers `null` for a directory that is not a repository, which is an
    /// ordinary thing for a thread to be running in.
    Capture {
        repo: String,
        thread_id: String,
        edge: Edge,
    },
    /// Every checkpoint a thread still has, oldest first.
    List {
        repo: String,
        thread_id: String,
    },
    /// What changed across a turn. The file list is what a panel draws; the
    /// patch is only produced when something wants the turn whole, as text.
    Diff {
        repo: String,
        from: String,
        to: String,
        patch: bool,
    },
    /// One file at both ends of a turn, in the shape the diff view reads.
    FileVersions {
        repo: String,
        from: String,
        to: String,
        file: String,
    },
    /// Puts the working tree back to a checkpoint. **The tree only** — not the
    /// index, not HEAD, and not the agent's conversation.
    ///
    /// The thread is named because the restore checkpoints the tree it is about
    /// to overwrite, and that snapshot belongs in the same thread's list as the
    /// turn being reverted: that is where the user goes looking for it.
    Restore {
        repo: String,
        thread_id: String,
        sha: String,
    },
    /// Drops every checkpoint of a thread. What a deleted thread leaves behind.
    Forget {
        repo: String,
        thread_id: String,
    },
}

impl Checkpoints {
    pub(super) fn decode(method: &str, params: &Value) -> Result<Self, String> {
        let repo = || str_param(params, "repo");
        let thread_id = || str_param(params, "threadId");
        Ok(match method {
            "checkpoint.capture" => Checkpoints::Capture {
                repo: repo()?,
                thread_id: thread_id()?,
                edge: match str_param(params, "edge")?.as_str() {
                    "start" => Edge::Start,
                    "end" => Edge::End,
                    other => return Err(format!("a turn has no {other} edge")),
                },
            },
            "checkpoint.list" => Checkpoints::List {
                repo: repo()?,
                thread_id: thread_id()?,
            },
            "checkpoint.diff" => Checkpoints::Diff {
                repo: repo()?,
                from: str_param(params, "from")?,
                to: str_param(params, "to")?,
                patch: bool_param(params, "patch", false),
            },
            "checkpoint.fileVersions" => Checkpoints::FileVersions {
                repo: repo()?,
                from: str_param(params, "from")?,
                to: str_param(params, "to")?,
                file: str_param(params, "file")?,
            },
            "checkpoint.restore" => Checkpoints::Restore {
                repo: repo()?,
                thread_id: thread_id()?,
                sha: str_param(params, "sha")?,
            },
            "checkpoint.forget" => Checkpoints::Forget {
                repo: repo()?,
                thread_id: thread_id()?,
            },
            other => return Err(format!("unknown method: {other}")),
        })
    }

    pub(super) fn name(&self) -> &'static str {
        match self {
            Checkpoints::Capture { .. } => "checkpoint.capture",
            Checkpoints::List { .. } => "checkpoint.list",
            Checkpoints::Diff { .. } => "checkpoint.diff",
            Checkpoints::FileVersions { .. } => "checkpoint.fileVersions",
            Checkpoints::Restore { .. } => "checkpoint.restore",
            Checkpoints::Forget { .. } => "checkpoint.forget",
        }
    }

    pub(super) fn wire(&self) -> Wire {
        match self {
            Checkpoints::Capture { .. }
            | Checkpoints::Diff { .. }
            | Checkpoints::FileVersions { .. } => Wire::Bare,
            Checkpoints::List { .. } => Wire::Key("checkpoints"),
            Checkpoints::Restore { .. } | Checkpoints::Forget { .. } => Wire::Ok,
        }
    }

    /// Writing a ref is a write, even though nothing the user can see moves.
    pub(super) fn capability(&self) -> Capability {
        match self {
            Checkpoints::List { .. }
            | Checkpoints::Diff { .. }
            | Checkpoints::FileVersions { .. } => Capability::ReadProject,
            Checkpoints::Capture { .. }
            | Checkpoints::Restore { .. }
            | Checkpoints::Forget { .. } => Capability::MutateProject,
        }
    }

    /// The repository, every time. A sha, a thread id and a turn edge are not
    /// paths; the file `fileVersions` names never reaches the filesystem, since
    /// it is read out of a git object and `checkpoint::file_at_edges_blocking`
    /// refuses anything that is not repo-relative.
    fn caller_paths(&self) -> Vec<&str> {
        match self {
            Checkpoints::Capture { repo, .. }
            | Checkpoints::List { repo, .. }
            | Checkpoints::Diff { repo, .. }
            | Checkpoints::FileVersions { repo, .. }
            | Checkpoints::Restore { repo, .. }
            | Checkpoints::Forget { repo, .. } => vec![repo],
        }
    }

    pub(super) fn prepare(self, host: &dyn Host) -> Result<Ready, String> {
        for path in self.caller_paths() {
            host.roots().ensure_allowed(path)?;
        }
        Ok(Ready::Work(Command::Checkpoints(self)))
    }

    pub(super) fn run(self) -> Result<Value, String> {
        Ok(match self {
            Checkpoints::Capture {
                repo,
                thread_id,
                edge,
            } => value_of(checkpoint::capture_blocking(&repo, &thread_id, edge)?),
            Checkpoints::List { repo, thread_id } => {
                value_of(checkpoint::list_blocking(&repo, &thread_id)?)
            }
            Checkpoints::Diff {
                repo,
                from,
                to,
                patch,
            } => value_of(checkpoint::diff_blocking(&repo, &from, &to, patch)?),
            Checkpoints::FileVersions {
                repo,
                from,
                to,
                file,
            } => value_of(checkpoint::file_at_edges_blocking(&repo, &from, &to, &file)?),
            Checkpoints::Restore {
                repo,
                thread_id,
                sha,
            } => {
                checkpoint::restore_blocking(&repo, &thread_id, &sha)?;
                Value::Null
            }
            Checkpoints::Forget { repo, thread_id } => {
                checkpoint::forget_blocking(&repo, &thread_id)?;
                Value::Null
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::Grant;
    use crate::command::Scoped;
    use crate::scope::ProjectRoots;
    use serde_json::json;

    fn every_param(path: &str) -> Value {
        json!({
            "repo": path,
            "threadId": "thread-1",
            "edge": "start",
            "from": "aaa",
            "to": "bbb",
            "sha": "aaa",
            "file": "a.txt",
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

    #[test]
    fn no_command_prepares_outside_the_registered_roots() {
        let outside = std::env::temp_dir().join(format!("boite-ckpt-cmd-{}", std::process::id()));
        std::fs::create_dir_all(&outside).unwrap();
        let outside = std::fs::canonicalize(&outside).unwrap();
        let root = std::env::temp_dir().join(format!("boite-ckpt-root-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let roots = ProjectRoots::default();
        roots.replace(vec![std::fs::canonicalize(&root)
            .unwrap()
            .to_string_lossy()
            .to_string()]);
        let host = Scoped::new(&roots);
        let params = every_param(outside.to_str().unwrap());

        for method in ALL_METHODS {
            let err = Command::decode(method, &params)
                .unwrap()
                .prepare(&host, Grant::Local)
                .err()
                .unwrap_or_else(|| panic!("{method} accepted a path outside the roots"));
            assert!(
                err.contains("outside registered project roots"),
                "{method} refused for the wrong reason: {err}"
            );
        }
        let _ = std::fs::remove_dir_all(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An edge is a closed vocabulary, and a turn has exactly two ends. Anything
    /// else is a caller that thinks `waiting` or `shell` finishes a turn.
    #[test]
    fn only_the_two_ends_of_a_turn_are_an_edge() {
        for (raw, edge) in [("start", Edge::Start), ("end", Edge::End)] {
            let decoded = Checkpoints::decode(
                "checkpoint.capture",
                &json!({ "repo": ".", "threadId": "t", "edge": raw }),
            )
            .unwrap();
            assert!(matches!(decoded, Checkpoints::Capture { edge: e, .. } if e == edge));
        }
        let err = Checkpoints::decode(
            "checkpoint.capture",
            &json!({ "repo": ".", "threadId": "t", "edge": "waiting" }),
        )
        .unwrap_err();
        assert_eq!(err, "a turn has no waiting edge");
    }

    #[test]
    fn the_protocol_envelopes_are_what_shipped() {
        let params = every_param("/tmp/whatever");
        let expected: &[(&str, Wire)] = &[
            ("checkpoint.capture", Wire::Bare),
            ("checkpoint.list", Wire::Key("checkpoints")),
            ("checkpoint.diff", Wire::Bare),
            ("checkpoint.fileVersions", Wire::Bare),
            ("checkpoint.restore", Wire::Ok),
            ("checkpoint.forget", Wire::Ok),
        ];
        assert_eq!(expected.len(), ALL_METHODS.len());
        for (method, wire) in expected {
            assert_eq!(Command::decode(method, &params).unwrap().wire(), *wire, "{method}");
        }
    }
}
