//! Whether a turn may end without throwing work away.
//!
//! Read by the Stop hook, not chosen by the model: a tool is something an
//! agent elects to call, and the point here is the turn where it chose not to.
//! Three objections, worst first. Everything that is not a clear objection
//! allows the stop, because this is the only mechanism that can hold a
//! conversation open against the user's wishes.

use std::path::Path;
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::git::{self, WorktreeHold};

/// What the hook prints, and what the endpoint answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finish {
    pub allow: bool,
    /// Why not, when it is not allowed. Named for the agent, not for us.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The one tool that keeps what would be lost.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep: Option<String>,
}

impl Finish {
    fn allow() -> Finish {
        Finish {
            allow: true,
            reason: None,
            keep: None,
        }
    }

    fn block(reason: &str, keep: &str) -> Finish {
        Finish {
            allow: false,
            reason: Some(reason.into()),
            keep: Some(keep.into()),
        }
    }
}

/// Decide whether this turn may stop.
///
/// `already_active` is Claude's `stop_hook_active`: a hook that can fire
/// twice for the same stop can never stop firing, so the second pass allows
/// unconditionally.
pub fn decide(worktree: Option<&str>, already_active: bool) -> Finish {
    if already_active {
        return Finish::allow();
    }
    let Some(path) = worktree.filter(|p| !p.is_empty() && Path::new(p).is_dir()) else {
        return Finish::allow();
    };

    let hold = match git::worktree_hold_blocking(path) {
        Ok(h) => h,
        Err(_) => return Finish::allow(),
    };
    if let Some(blocked) = objection_from_hold(&hold) {
        return blocked;
    }

    unpublished_branch(path).unwrap_or_else(Finish::allow)
}

fn objection_from_hold(hold: &WorktreeHold) -> Option<Finish> {
    match (hold.dirty, hold.orphan_commits) {
        (true, true) => Some(Finish::block(
            "this worktree has uncommitted changes and commits on no branch; closing the thread throws both away",
            "worktree_branch",
        )),
        (true, false) => Some(Finish::block(
            "this worktree has uncommitted changes; closing the thread throws them away",
            "worktree_branch",
        )),
        (false, true) => Some(Finish::block(
            "this worktree has commits on no branch; closing the thread throws them away",
            "worktree_branch",
        )),
        (false, false) => None,
    }
}

/// A branch the repository has a remote for, and that remote does not have.
///
/// Skipped when there is no remote at all: a project that never had one is
/// not behind on pushing.
fn unpublished_branch(path: &str) -> Option<Finish> {
    if !has_remote(path) {
        return None;
    }
    let info = git::repo_info_blocking(path).ok()?;
    let branch = info.branch?;
    // Two states, and the recovery differs: one wants a first push, the other
    // wants a push. Saying "not on a remote" for a branch that is on one sends
    // an agent looking for a remote it already has.
    let reason = match (&info.upstream, info.ahead) {
        (None, _) => format!(
            "branch '{branch}' is not on a remote; closing the thread keeps the checkout but nothing else has the commits"
        ),
        (Some(upstream), ahead) if ahead > 0 => format!(
            "branch '{branch}' is {ahead} {} ahead of {upstream}; closing the thread keeps the checkout but the remote does not have {}",
            if ahead == 1 { "commit" } else { "commits" },
            if ahead == 1 { "it" } else { "them" }
        ),
        _ => return None,
    };
    Some(Finish::block(&reason, "worktree_status"))
}

fn has_remote(path: &str) -> bool {
    let mut cmd = Command::new("git");
    cmd.args(["-C", path, "remote"]);
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("LC_ALL", "C");
    cmd.stdin(Stdio::null());
    cmd.output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn scratch(tag: &str) -> PathBuf {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "boite-finish-{}-{tag}-{n}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git_ok(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .output()
            .expect("git");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_repo(tag: &str) -> PathBuf {
        let dir = scratch(tag);
        git_ok(&dir, &["init", "-b", "master"]);
        git_ok(&dir, &["config", "user.email", "finish@test"]);
        git_ok(&dir, &["config", "user.name", "finish"]);
        fs::write(dir.join("a.txt"), "a\n").unwrap();
        git_ok(&dir, &["add", "a.txt"]);
        git_ok(&dir, &["commit", "-m", "init"]);
        dir
    }

    #[test]
    fn nothing_to_look_at_allows() {
        assert!(decide(None, false).allow);
        assert!(decide(Some(""), false).allow);
        assert!(decide(Some("/no/such/worktree"), false).allow);
    }

    #[test]
    fn a_second_stop_pass_allows() {
        let dir = init_repo("active");
        fs::write(dir.join("dirty.txt"), "x\n").unwrap();
        assert!(decide(dir.to_str(), true).allow);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn uncommitted_work_blocks() {
        let dir = init_repo("dirty");
        fs::write(dir.join("dirty.txt"), "x\n").unwrap();
        let out = decide(dir.to_str(), false);
        assert!(!out.allow, "{out:?}");
        assert!(out.reason.as_deref().unwrap().contains("uncommitted"), "{out:?}");
        assert_eq!(out.keep.as_deref(), Some("worktree_branch"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_clean_checkout_with_no_remote_allows() {
        let dir = init_repo("clean");
        let out = decide(dir.to_str(), false);
        assert!(out.allow, "{out:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_branch_with_a_remote_and_no_upstream_blocks() {
        let dir = init_repo("ahead");
        let remote = scratch("remote.git");
        git_ok(&remote, &["init", "--bare", "-b", "master"]);
        git_ok(
            &dir,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        let out = decide(dir.to_str(), false);
        assert!(!out.allow, "{out:?}");
        assert!(
            out.reason.as_deref().unwrap().contains("not on a remote"),
            "{out:?}"
        );
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&remote);
    }

    /// The other half of the same block, and the half whose recovery is a
    /// plain push: the branch is on the remote, the remote is just behind.
    #[test]
    fn a_branch_ahead_of_its_upstream_is_not_called_absent_from_the_remote() {
        let dir = init_repo("pushed");
        let remote = scratch("pushed-remote.git");
        git_ok(&remote, &["init", "--bare", "-b", "master"]);
        git_ok(&dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git_ok(&dir, &["push", "-u", "origin", "master"]);

        let out = decide(dir.to_str(), false);
        assert!(out.allow, "a branch level with its upstream should pass: {out:?}");

        fs::write(dir.join("later.txt"), "x\n").unwrap();
        git_ok(&dir, &["add", "-A"]);
        git_ok(&dir, &["commit", "-m", "later"]);

        let out = decide(dir.to_str(), false);
        assert!(!out.allow, "{out:?}");
        let reason = out.reason.as_deref().unwrap();
        assert!(
            !reason.contains("not on a remote"),
            "the branch is on the remote, so this sends the agent after a remote it has: {reason}"
        );
        assert!(reason.contains("ahead of origin/master"), "{reason}");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&remote);
    }
}
