//! What a forge says about work that has already left the machine.
//!
//! Two questions, both answered by shelling out rather than by talking to an
//! API: whether a commit an agent claimed is really in the repository, and
//! whether a branch has a pull request. `gh` is optional, and every answer here
//! has a shape for "it could not say" that is not an error — an agent's claim is
//! shown as unverified rather than as false.

use super::*;

/// What a repository can say about a commit an agent claims to have made.
/// `known` false means git has never heard of it — the sha was mistyped, or
/// invented, or belongs to another clone.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommitState {
    pub known: bool,
    pub pushed: bool,
    pub short: String,
    pub subject: Option<String>,
    /// A local branch holding the commit, preferring the one checked out, for
    /// looking a pull request up by head.
    pub branch: Option<String>,
}

/// A sha is untrusted input reaching a command line. It is passed as an
/// argument and never through a shell, so this is not the thing standing
/// between us and injection — but a value that cannot be a sha has no business
/// being tried, and `--flag`-shaped input is exactly what argument parsers
/// mistake for their own.
fn looks_like_sha(sha: &str) -> bool {
    (7..=40).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())
}

/// Reads a claimed commit back out of the repository: does it exist, and has it
/// left this machine. Both answers come from git, so a sha nothing backs shows
/// up as unknown rather than as a tick.
pub fn commit_state_blocking(path: &str, sha: &str) -> CommitState {
    let p = Path::new(path);
    if !p.is_dir() || !looks_like_sha(sha) {
        return CommitState::default();
    }

    // `^{commit}` so a tag or a tree with that name is not mistaken for one.
    let mut cmd = git(p);
    cmd.args(["rev-parse", "--verify", "--quiet", &format!("{sha}^{{commit}}")]);
    let Ok(out) = run(cmd) else {
        return CommitState::default();
    };
    let full = String::from_utf8_lossy(&out).trim().to_string();
    if full.is_empty() {
        return CommitState::default();
    }

    let subject = {
        let mut cmd = git(p);
        cmd.args(["log", "-1", "--format=%s", &full]);
        run(cmd)
            .ok()
            .map(|o| String::from_utf8_lossy(&o).trim().to_string())
            .filter(|s| !s.is_empty())
    };

    // On a remote-tracking branch is the only evidence that it left: a local
    // branch being ahead says nothing about where the commit is.
    let remote_refs: Vec<String> = {
        let mut cmd = git(p);
        cmd.args(["branch", "-r", "--contains", &full, "--format=%(refname:short)"]);
        run(cmd)
            .map(|o| {
                String::from_utf8_lossy(&o)
                    .lines()
                    .map(|l| l.trim().to_string())
                    // origin/HEAD is a pointer at the default branch, not a
                    // branch anyone opened a pull request from.
                    .filter(|l| !l.is_empty() && !l.ends_with("/HEAD"))
                    .collect()
            })
            .unwrap_or_default()
    };
    let pushed = !remote_refs.is_empty();

    let local_branch = {
        let mut cmd = git(p);
        cmd.args(["branch", "--contains", &full, "--format=%(HEAD)%(refname:short)"]);
        run(cmd).ok().and_then(|o| {
            let text = String::from_utf8_lossy(&o);
            let mut names: Vec<String> = Vec::new();
            for line in text.lines() {
                let line = line.trim();
                // `%(HEAD)` marks the checked-out branch with `*`; it is the one
                // a pull request would have been opened from.
                if let Some(rest) = line.strip_prefix('*') {
                    return Some(rest.trim().to_string());
                }
                if !line.is_empty() {
                    names.push(line.to_string());
                }
            }
            names.into_iter().next()
        })
    };

    // Falling back to the remote ref, minus its remote name: work pushed from a
    // branch this clone never had, or has since deleted, still has a pull
    // request — and without a name for it nothing would ever go looking.
    let branch = local_branch.or_else(|| {
        remote_refs
            .first()
            .and_then(|r| r.split_once('/').map(|(_, name)| name.to_string()))
    });

    CommitState {
        known: true,
        pushed,
        short: full.chars().take(7).collect(),
        subject,
        branch,
    }
}

/// A pull request as `gh` reports it. Not a git concept: git knows the commit
/// left the machine, nothing more, and the rest lives on the forge.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub state: String,
    pub url: String,
}

/// The outcome of asking `gh` about a branch.
///
/// Four answers rather than an option, because "no pull request" and "could not
/// ask" are not the same thing to the person reading the row. Two of them are
/// worth saying out loud — `gh` is there but signed out, or it failed — and two
/// are not: no `gh` at all, and a repository that is not on GitHub are both
/// simply outside what this can answer.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PrLookup {
    /// No `gh`, or no GitHub remote. Nothing to report and nothing to fix.
    Unavailable,
    /// `gh` answered, and there is no pull request for this branch.
    NotFound,
    Found { pr: PullRequest },
    /// `gh` was reachable and refused. `auth` marks the one case the user can
    /// act on directly, which `gh` reports with exit code 4.
    Failed { auth: bool, detail: String },
}

/// Turns a refusal from `gh` into something the panel can say, kept apart from
/// the process handling so both branches can be tested against the real
/// messages rather than against a guess at them.
pub(super) fn classify_gh_failure(code: Option<i32>, stderr: &str) -> PrLookup {
    let detail = stderr.lines().next().unwrap_or("").trim().to_string();
    // Not a GitHub repository at all. gh is right to refuse and there is
    // nothing for the user to do about it, so this is silence like a missing
    // gh rather than a failure.
    if detail.contains("known GitHub host") {
        return PrLookup::Unavailable;
    }
    PrLookup::Failed {
        // gh exits 4 when it wants `gh auth login`: the one outcome here the
        // user can act on, and so the one worth naming.
        auth: code == Some(4),
        detail: if detail.is_empty() {
            match code {
                Some(c) => format!("gh exited with {c}"),
                None => "gh was killed".into(),
            }
        } else {
            detail
        },
    }
}

/// The pull request opened from this branch.
///
/// This is the only part of the strip that reaches the network, so it is also
/// the only part with a deadline and a kill behind it.
pub fn pull_request_for_branch_blocking(path: &str, branch: &str) -> PrLookup {
    let p = Path::new(path);
    if !p.is_dir() || branch.is_empty() || branch.starts_with('-') {
        return PrLookup::Unavailable;
    }

    let mut cmd = Command::new("gh");
    cmd.current_dir(p);
    cmd.args([
        "pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json",
        "number,state,url",
    ]);
    // gh asks interactively when it is not authenticated, and a prompt waiting
    // on a terminal nobody is looking at is exactly the hang this must not have.
    cmd.env("GH_PROMPT_DISABLED", "1");
    cmd.env("GH_NO_UPDATE_NOTIFIER", "1");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    // Kept rather than dropped: it carries the difference between a signed-out
    // gh and a repository gh has no business answering about.
    cmd.stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    // Failing to spawn is `gh` not being installed, which is not a problem to
    // report — most machines do not have it, and nothing here needs it.
    let Ok(mut child) = cmd.spawn() else {
        return PrLookup::Unavailable;
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            // Past the deadline, or waiting failed: leave nothing running behind
            // a panel that has already given up on the answer.
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return PrLookup::Failed {
                    auth: false,
                    detail: "gh did not answer in time".into(),
                };
            }
        }
    }

    let Ok(out) = child.wait_with_output() else {
        return PrLookup::Unavailable;
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return classify_gh_failure(out.status.code(), &stderr);
    }

    let Ok(parsed) = serde_json::from_slice::<Vec<serde_json::Value>>(&out.stdout) else {
        return PrLookup::Failed {
            auth: false,
            detail: "gh returned something that is not a pull request list".into(),
        };
    };
    let Some(pr) = parsed.into_iter().next() else {
        return PrLookup::NotFound;
    };
    let Some(number) = pr.get("number").and_then(|v| v.as_u64()) else {
        return PrLookup::NotFound;
    };
    PrLookup::Found {
        pr: PullRequest {
            number,
            state: pr
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("UNKNOWN")
                .to_string(),
            url: pr
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        },
    }
}

