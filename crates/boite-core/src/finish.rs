//! What is not finished when an agent says it is.
//!
//! A Boite thread works in a detached worktree, and a detached worktree is
//! discarded when the thread closes. So the moment an agent ends its turn is the
//! last moment anybody can be told that the work is still sitting somewhere that
//! throws it away. Nothing else in the app is looking at that moment: the user
//! reads the answer, closes the terminal, and the diff was never anywhere.
//!
//! **Guard rails, and why they are not optional.** This decides whether a hook
//! sends an agent back to work, which is the one mechanism in the app that can
//! hold a conversation open against the user's wishes. Buzz's version of this is
//! the reference and its rule is the right one: a hook that can fire twice for
//! the same stop is a hook that can never stop firing. So the caller answers
//! once per stop and every failure allows. The list here is capped, and each
//! entry names what is lost and the one call that fixes it, because an objection
//! an agent cannot act on is an objection it argues with.
//!
//! **What is not in it.** A todo the agent left open. The three states are
//! `open`, `claimed` and `done`, and `claimed` is already the agent's finish
//! line: it means the work is reported and waiting on a human. There is no state
//! for "an agent is on this right now", so there is no row that can be read as
//! unfinished by the thread that is stopping. Objecting on `open` instead would
//! fire on every card in the project, most of which are nobody's.

use serde::Serialize;

/// What the repository under a thread still holds.
///
/// Read off git rather than remembered, so it stays true across a restart, a
/// crash and a worktree Boite did not make.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loose {
    /// Modified, staged or untracked files.
    pub dirty: bool,
    /// No local branch contains HEAD, so these commits live in this directory
    /// and nowhere else.
    pub orphan_commits: bool,
    /// The branch this worktree is on, when it took one.
    pub branch: Option<String>,
    /// Commits no remote has. Only meaningful when the repository has one.
    pub unshared: u32,
    /// Whether the repository has any remote at all. A project that has never
    /// had one is not behind on pushing; it is a local project.
    pub has_remote: bool,
}

/// One thing that is not finished, and the call that finishes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Objection {
    /// `uncommitted`, `detached` or `unpushed`. Stable, so a caller can decide
    /// what to do with one without reading the sentence.
    pub kind: &'static str,
    /// What is lost, and the one call that keeps it. Written to be read by an
    /// agent that is about to answer a human.
    pub text: String,
}

/// The most that is ever raised at once. Three is the whole list, and a cap that
/// happens to equal the list is still worth having: it is what stops the next
/// objection somebody adds from turning this into a wall of text.
pub const MAX_OBJECTIONS: usize = 3;

/// What is not finished, worst first.
///
/// "Worst" is by what is destroyed and how quietly. Uncommitted files and
/// orphaned commits both die with the worktree, and the first is the one nobody
/// expects because it looks like an ordinary checkout. A branch nothing has
/// pushed survives, so it comes last and only when there is a remote to push to.
pub fn objections(loose: &Loose) -> Vec<Objection> {
    let mut out = Vec::new();
    if loose.dirty {
        out.push(Objection {
            kind: "uncommitted",
            text: "This terminal's worktree has uncommitted changes. It is a detached \
                   worktree of the project, so closing the thread discards them and the \
                   user's own checkout never sees them. Commit them, or tell the user \
                   plainly what you are leaving behind."
                .into(),
        });
    }
    if loose.orphan_commits {
        out.push(Objection {
            kind: "detached",
            text: "The commits here are on a detached head: no branch holds them, so they \
                   go away with the worktree. Call worktree_branch to put them on a new \
                   branch, or worktree_reserve to continue one that exists."
                .into(),
        });
    }
    if loose.has_remote && loose.unshared > 0 {
        if let Some(branch) = loose.branch.as_deref().filter(|b| !b.is_empty()) {
            out.push(Objection {
                kind: "unpushed",
                text: format!(
                    "Branch {branch} has {} commit{} no remote has. Push it, or say it is \
                     meant to stay on this machine.",
                    loose.unshared,
                    if loose.unshared == 1 { "" } else { "s" }
                ),
            });
        }
    }
    out.truncate(MAX_OBJECTIONS);
    out
}

/// The whole objection as one message, or nothing when there is none.
///
/// The last line is not decoration. Without it an agent reads a block as a
/// failure to route around and calls the same tool again; told the check runs
/// once, it does the work and answers.
pub fn reason(objections: &[Objection]) -> Option<String> {
    if objections.is_empty() {
        return None;
    }
    let mut out =
        String::from("Boite: this turn is ending with work that nothing outside this terminal has.\n");
    for o in objections {
        out.push_str("\n- ");
        out.push_str(&o.text);
    }
    out.push_str(
        "\n\nDo one of those, then answer the user. This check runs once per stop, so \
         deciding to leave it as it is also ends the turn.",
    );
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(loose: &Loose) -> Vec<&'static str> {
        objections(loose).into_iter().map(|o| o.kind).collect()
    }

    #[test]
    fn a_finished_worktree_raises_nothing() {
        let clean = Loose {
            branch: Some("feat/x".into()),
            has_remote: true,
            ..Default::default()
        };
        assert!(objections(&clean).is_empty());
        assert_eq!(reason(&objections(&clean)), None);
    }

    #[test]
    fn what_dies_with_the_worktree_comes_first() {
        let loose = Loose {
            dirty: true,
            orphan_commits: true,
            unshared: 4,
            has_remote: true,
            branch: Some("feat/x".into()),
        };
        assert_eq!(kinds(&loose), ["uncommitted", "detached", "unpushed"]);
    }

    /// A project that has never had a remote is not behind on pushing. Objecting
    /// there would fire on every turn of every local repository, which is the
    /// shape of a hook nobody leaves switched on.
    #[test]
    fn a_repository_with_no_remote_is_not_behind() {
        let loose = Loose {
            branch: Some("master".into()),
            unshared: 12,
            has_remote: false,
            ..Default::default()
        };
        assert!(objections(&loose).is_empty());
    }

    /// The unpushed objection names a branch, so a detached head cannot raise it
    /// even with commits nothing has. That case is already `detached`, and it is
    /// the one that says something is about to be lost.
    #[test]
    fn a_detached_head_is_never_reported_as_unpushed() {
        let loose = Loose {
            orphan_commits: true,
            unshared: 3,
            has_remote: true,
            branch: None,
            dirty: false,
        };
        assert_eq!(kinds(&loose), ["detached"]);
    }

    #[test]
    fn one_commit_is_not_spelled_as_several() {
        let one = Loose {
            branch: Some("b".into()),
            unshared: 1,
            has_remote: true,
            ..Default::default()
        };
        assert!(objections(&one)[0].text.contains("1 commit no remote"));
        let two = Loose {
            unshared: 2,
            ..one
        };
        assert!(objections(&two)[0].text.contains("2 commits no remote"));
    }

    /// The message tells the agent the check does not repeat. Without that it
    /// reads a block as something to route around, and tries the same tool again
    /// instead of doing the work.
    #[test]
    fn the_message_says_the_check_happens_once() {
        let loose = Loose {
            dirty: true,
            ..Default::default()
        };
        let text = reason(&objections(&loose)).unwrap();
        assert!(text.contains("once per stop"), "{text}");
        assert!(text.contains("uncommitted changes"), "{text}");
    }
}
