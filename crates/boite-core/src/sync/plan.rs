//! Deciding, per file, which way it goes — and which ones nobody but the user
//! can decide.
//!
//! Three sides: what this machine holds, what the repository holds, and the
//! **base**, which is the repository as it stood the last time this machine
//! finished a sync. Without the base there is no way to tell "I changed this"
//! from "they changed this", and every difference would have to be a conflict.
//!
//! The base's *absence* is load-bearing. No base means this machine has never
//! synced, so the base is the empty tree, so everything that differs on both
//! sides classifies as diverged and goes to the merge tool. The hardest
//! requirement — that the very first sync on a machine which already has
//! configuration never overwrites anything — falls out of the model instead of
//! being a special case somebody has to remember to write.
//!
//! One policy stated once: **a deletion never propagates.** A file missing here
//! and present in the repository is indistinguishable from one belonging to an
//! agent that was never installed on this machine, and "never overwrite"
//! outranks "propagate everything". Deleting from the repository by hand still
//! works, and is the honest way to mean it.

use std::collections::{BTreeMap, BTreeSet};

use super::manifest;

pub type Files = BTreeMap<String, Vec<u8>>;

/// Which way one file goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Class {
    /// The same on both sides, and the same as the base.
    Unchanged,
    /// Changed here since the base, and not there.
    LocalOnly,
    /// Changed there since the base, and not here.
    RemoteOnly,
    /// Both sides moved, and landed on the same content. Nothing to write; the
    /// base catches up.
    Converged,
    /// Both sides moved, and differently. The only class this module will not
    /// resolve.
    Diverged,
}

/// One file the user has to decide about, with all three sides in hand.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Divergence {
    pub path: String,
    /// Which switch owns it, so the panel can group and label.
    pub source_id: String,
    /// The last agreed content, when there was one. A merge tool with a base can
    /// tell an addition from a deletion; without one it can still show both
    /// sides, which is what a first sync gets.
    pub base: Option<String>,
    pub local: Option<String>,
    pub remote: Option<String>,
    /// Either side is not text. Stacking bytes is meaningless, so the panel
    /// offers a side rather than a merge.
    pub binary: bool,
}

#[derive(Debug, Default, Clone)]
pub struct Plan {
    /// What to write onto this machine.
    pub to_machine: Files,
    /// What to stage into the mirror.
    pub to_repo: Files,
    /// What only the user can settle.
    pub diverged: Vec<Divergence>,
    pub unchanged: usize,
    pub converged: usize,
}

impl Plan {
    /// Whether the base may move forward.
    ///
    /// It may not while anything is unresolved: an unmerged file has to stay
    /// diverged until it is settled, or the next sync would read the other
    /// machine's version as agreed and quietly adopt it.
    pub fn settled(&self) -> bool {
        self.diverged.is_empty()
    }
}

/// Classifies every path across the three sides.
pub fn compare(local: &Files, remote: &Files, base: &Files) -> Plan {
    let mut plan = Plan::default();
    let paths: BTreeSet<&String> =
        local.keys().chain(remote.keys()).chain(base.keys()).collect();
    for path in paths {
        match classify(local.get(path), remote.get(path), base.get(path)) {
            Class::Unchanged => plan.unchanged += 1,
            Class::Converged => plan.converged += 1,
            Class::LocalOnly => {
                if let Some(bytes) = local.get(path) {
                    plan.to_repo.insert(path.clone(), bytes.clone());
                }
            }
            Class::RemoteOnly => {
                if let Some(bytes) = remote.get(path) {
                    plan.to_machine.insert(path.clone(), bytes.clone());
                }
            }
            Class::Diverged => plan.diverged.push(divergence(
                path,
                local.get(path),
                remote.get(path),
                base.get(path),
            )),
        }
    }
    plan
}

/// The lattice, in one place.
///
/// Absence is a value in it rather than a case handled somewhere else, which is
/// what keeps the deletion policy from being spread across four branches.
pub fn classify(local: Option<&Vec<u8>>, remote: Option<&Vec<u8>>, base: Option<&Vec<u8>>) -> Class {
    match (local, remote) {
        (None, None) => Class::Unchanged,
        // Gone from the repository. Whether it was deleted there or has simply
        // never been there, this machine's copy is what travels: a deletion does
        // not propagate.
        (Some(_), None) => Class::LocalOnly,
        // Not here. Either it is new in the repository, or this machine deleted
        // it — and the same policy applies, so it comes back.
        (None, Some(_)) => Class::RemoteOnly,
        (Some(here), Some(there)) if here == there => {
            if base == Some(here) {
                Class::Unchanged
            } else {
                Class::Converged
            }
        }
        (Some(here), Some(there)) => match (base != Some(here), base != Some(there)) {
            (true, false) => Class::LocalOnly,
            (false, true) => Class::RemoteOnly,
            // Both moved, and not together. Nobody but the user can settle it.
            (true, true) => Class::Diverged,
            // The base equals both sides, which already differ. Unreachable, and
            // read as a divergence rather than trusted: the alternative is
            // picking a side on a contradiction.
            (false, false) => Class::Diverged,
        },
    }
}

fn divergence(
    path: &str,
    local: Option<&Vec<u8>>,
    remote: Option<&Vec<u8>>,
    base: Option<&Vec<u8>>,
) -> Divergence {
    let as_text = |bytes: Option<&Vec<u8>>| bytes.and_then(|raw| String::from_utf8(raw.clone()).ok());
    let local_text = as_text(local);
    let remote_text = as_text(remote);
    Divergence {
        path: path.to_string(),
        source_id: manifest::from_repo_path(path)
            .map(|named| named.id.to_string())
            .unwrap_or_default(),
        base: as_text(base),
        binary: local.is_some() && local_text.is_none()
            || remote.is_some() && remote_text.is_none(),
        local: local_text,
        remote: remote_text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(pairs: &[(&str, &str)]) -> Files {
        pairs.iter().map(|(path, body)| ((*path).to_string(), body.as_bytes().to_vec())).collect()
    }

    fn bytes(body: &str) -> Vec<u8> {
        body.as_bytes().to_vec()
    }

    /// One case per row of the lattice, so a change to it has to change a test.
    #[test]
    fn the_five_classifications() {
        let a = bytes("a");
        let b = bytes("b");
        let c = bytes("c");

        assert_eq!(classify(Some(&a), Some(&a), Some(&a)), Class::Unchanged);
        assert_eq!(classify(Some(&b), Some(&a), Some(&a)), Class::LocalOnly);
        assert_eq!(classify(Some(&a), Some(&b), Some(&a)), Class::RemoteOnly);
        assert_eq!(classify(Some(&b), Some(&b), Some(&a)), Class::Converged);
        assert_eq!(classify(Some(&b), Some(&c), Some(&a)), Class::Diverged);
    }

    /// The requirement the whole base design exists for: a machine that has
    /// never synced and already has configuration puts every difference in front
    /// of the user, and writes nothing on its own.
    #[test]
    fn a_first_sync_puts_everything_that_differs_in_front_of_the_merge_tool() {
        let local = files(&[
            ("agents/.agents/AGENTS.md", "# mine\n"),
            ("claude/.claude/settings.json", r#"{"model":"opus"}"#),
        ]);
        let remote = files(&[
            ("agents/.agents/AGENTS.md", "# theirs\n"),
            ("claude/.claude/settings.json", r#"{"model":"sonnet"}"#),
        ]);
        let plan = compare(&local, &remote, &Files::new());

        assert_eq!(plan.diverged.len(), 2, "{:?}", plan.diverged);
        assert!(plan.to_machine.is_empty(), "a first sync wrote to the machine");
        assert!(plan.to_repo.is_empty(), "a first sync pushed over the other side");
        assert!(!plan.settled());
    }

    /// A first sync where the two sides already agree is not a conflict, and the
    /// base simply catches up.
    #[test]
    fn a_first_sync_that_already_agrees_is_not_a_conflict() {
        let both = files(&[("agents/.agents/AGENTS.md", "# same\n")]);
        let plan = compare(&both, &both, &Files::new());
        assert!(plan.diverged.is_empty());
        assert_eq!(plan.converged, 1);
        assert!(plan.settled());
    }

    /// Deleted here, still in the repository: it comes back rather than being
    /// removed there. "Deleted" and "this agent was never installed here" look
    /// identical from the repository.
    #[test]
    fn a_local_deletion_is_not_propagated() {
        let base = files(&[("agents/.agents/AGENTS.md", "# was\n")]);
        let plan = compare(&Files::new(), &base, &base);
        assert!(plan.to_repo.is_empty());
        assert_eq!(plan.to_machine.len(), 1);
        assert!(plan.diverged.is_empty());
    }

    /// Deleted in the repository, still here: it is pushed back rather than
    /// removed from this machine.
    #[test]
    fn a_remote_deletion_is_not_propagated() {
        let base = files(&[("agents/.agents/AGENTS.md", "# was\n")]);
        let plan = compare(&base, &Files::new(), &base);
        assert!(plan.to_machine.is_empty());
        assert_eq!(plan.to_repo.len(), 1);
        assert!(plan.diverged.is_empty());
    }

    /// A new file on one side goes to the other, with nothing to ask about.
    #[test]
    fn a_file_new_on_one_side_travels_without_a_question() {
        let mine = files(&[("agents/.agents/new.md", "# new\n")]);
        let plan = compare(&mine, &Files::new(), &Files::new());
        assert_eq!(plan.to_repo.len(), 1);
        assert!(plan.diverged.is_empty());

        let plan = compare(&Files::new(), &mine, &Files::new());
        assert_eq!(plan.to_machine.len(), 1);
        assert!(plan.diverged.is_empty());
    }

    /// While anything is unresolved the base must not move, or the next sync
    /// would read the other machine's version as agreed and adopt it quietly.
    #[test]
    fn an_unmerged_file_does_not_let_the_base_move() {
        let plan = compare(
            &files(&[("agents/.agents/AGENTS.md", "# mine\n")]),
            &files(&[("agents/.agents/AGENTS.md", "# theirs\n")]),
            &files(&[("agents/.agents/AGENTS.md", "# base\n")]),
        );
        assert!(!plan.settled());
        assert!(plan.to_machine.is_empty() && plan.to_repo.is_empty());
    }

    /// A divergence carries which switch owns it, so the panel can group and
    /// label without a second lookup.
    #[test]
    fn a_divergence_names_the_source_it_belongs_to() {
        let plan = compare(
            &files(&[("claude/.claude/settings.json", r#"{"model":"opus"}"#)]),
            &files(&[("claude/.claude/settings.json", r#"{"model":"sonnet"}"#)]),
            &Files::new(),
        );
        assert_eq!(plan.diverged[0].source_id, "claude");
        assert!(!plan.diverged[0].binary);
        assert!(plan.diverged[0].base.is_none());
    }

    /// Stacking bytes is meaningless, so a binary side is flagged and the panel
    /// offers a side instead of a merge.
    #[test]
    fn a_side_that_is_not_text_is_flagged_rather_than_shown() {
        let mut remote = Files::new();
        remote.insert("agents/.agents/x.md".into(), vec![0xff, 0xfe, 0x00]);
        let plan = compare(&files(&[("agents/.agents/x.md", "# text\n")]), &remote, &Files::new());
        assert!(plan.diverged[0].binary);
        assert!(plan.diverged[0].remote.is_none());
        assert_eq!(plan.diverged[0].local.as_deref(), Some("# text\n"));
    }

    /// Both directions in one pass, because a real sync is rarely one-sided.
    #[test]
    fn both_directions_are_decided_in_one_pass() {
        let base = files(&[
            ("agents/.agents/a.md", "# base\n"),
            ("agents/.agents/b.md", "# base\n"),
            ("agents/.agents/c.md", "# base\n"),
        ]);
        let local = files(&[
            ("agents/.agents/a.md", "# mine\n"),
            ("agents/.agents/b.md", "# base\n"),
            ("agents/.agents/c.md", "# base\n"),
        ]);
        let remote = files(&[
            ("agents/.agents/a.md", "# base\n"),
            ("agents/.agents/b.md", "# theirs\n"),
            ("agents/.agents/c.md", "# base\n"),
        ]);
        let plan = compare(&local, &remote, &base);
        assert_eq!(plan.to_repo.keys().collect::<Vec<_>>(), vec!["agents/.agents/a.md"]);
        assert_eq!(plan.to_machine.keys().collect::<Vec<_>>(), vec!["agents/.agents/b.md"]);
        assert_eq!(plan.unchanged, 1);
        assert!(plan.settled());
    }
}
