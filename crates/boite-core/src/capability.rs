//! What a caller is allowed to ask for, in three words.
//!
//! Three, not thirty. A permission list with one entry per method is a list
//! nobody reads and that every new command has to be added to by hand, which is
//! the same failure mode the command bus exists to end. These three are the
//! only distinctions Boite can actually defend:
//!
//! - **[`Capability::ReadProject`]** looks at what is already there.
//! - **[`Capability::MutateProject`]** changes something inside one project.
//! - **[`Capability::MutateAcross`]** reaches past the project the caller is in:
//!   moving a thread somewhere else, opening a terminal in another project,
//!   creating one.
//!
//! The line that matters is the last one. An agent working in a repository is
//! expected to change files in it, and a permission system that asks about each
//! write is one the user clicks through. What it is not expected to do is
//! decide, on its own, to go and work somewhere else.
//!
//! Two grants, and a caller holds exactly one of them for the length of a
//! request. See [`Grant`].

/// What an operation needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Capability {
    ReadProject,
    MutateProject,
    MutateAcross,
}

impl Capability {
    /// What a refusal says. The agent reads it, so it names the thing that was
    /// missing rather than the enum variant.
    pub fn refusal(self) -> &'static str {
        match self {
            Capability::ReadProject => {
                "this credential cannot read that project. Boite issued it for another one."
            }
            Capability::MutateProject => {
                "this credential cannot change that project. Boite issued it for another one."
            }
            Capability::MutateAcross => {
                "this credential is scoped to one project, and that call reaches past it. \
                 Run from a terminal Boite opened if you need to move between projects."
            }
        }
    }
}

/// What a caller holds.
///
/// Deliberately two values rather than a set of capabilities. A set invites a
/// third combination that nothing issues, and then a code path that only that
/// combination reaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grant {
    /// A thread Boite spawned, proving itself with the key it was minted.
    ///
    /// Everything, including moving between projects: this is an agent running
    /// in a terminal the user opened, and the user watching that terminal is the
    /// gate. Approval gates narrow it further per command; see
    /// `crate::approval`.
    Owner,

    /// A credentials file, issued for one project.
    ///
    /// Reads and writes that project and nothing else. It cannot move a thread,
    /// spawn one elsewhere or create a project, because those are the calls that
    /// change *where* work happens, and a credential Boite handed to a process
    /// it did not launch has no terminal behind it for anyone to notice.
    Project,

    /// The user, at their own machine, through Boite's own window.
    ///
    /// Not a credential at all: this is the desktop's IPC and the WebSocket a
    /// device authenticated on. Named so the bus takes one argument from every
    /// caller instead of an `Option` that means "skip the check".
    Local,

    /// An orchestrator thread Boite spawned with a `role`.
    ///
    /// Not `Owner`, and that is the whole point: `Owner` reaches across
    /// projects because a user is watching that terminal, and an orchestrator
    /// is exactly the terminal the user is *not* watching. It reads and writes
    /// inside a project, and anything that changes *where* work happens goes
    /// through the approval queue like any other agent's ask.
    Conduct,
}

impl Grant {
    pub fn allows(self, capability: Capability) -> bool {
        match self {
            Grant::Owner | Grant::Local => true,
            Grant::Project => capability != Capability::MutateAcross,
            // Never `MutateAcross`, including for the global orchestrator: a
            // cross-project spawn has to land in the approval queue rather
            // than ride a grant nobody decided to widen.
            Grant::Conduct => capability != Capability::MutateAcross,
        }
    }

    /// The check, in the shape a caller wants it: `Ok(())` or the sentence.
    pub fn ensure(self, capability: Capability) -> Result<(), String> {
        if self.allows(capability) {
            return Ok(());
        }
        Err(capability.refusal().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_credentials_file_stops_at_the_edge_of_its_project() {
        assert!(Grant::Project.allows(Capability::ReadProject));
        assert!(Grant::Project.allows(Capability::MutateProject));
        assert!(!Grant::Project.allows(Capability::MutateAcross));
        assert!(Grant::Project.ensure(Capability::MutateAcross).is_err());
    }

    #[test]
    fn a_thread_and_the_user_reach_everything() {
        for grant in [Grant::Owner, Grant::Local] {
            for capability in [
                Capability::ReadProject,
                Capability::MutateProject,
                Capability::MutateAcross,
            ] {
                assert!(grant.ensure(capability).is_ok(), "{grant:?} {capability:?}");
            }
        }
    }

    /// An orchestrator never reaches across projects on its own grant. Any
    /// widening of this arm is a silent privilege escalation: the approval
    /// queue is what a cross-project spawn must go through.
    #[test]
    fn conduct_never_crosses() {
        assert!(Grant::Conduct.allows(Capability::ReadProject));
        assert!(Grant::Conduct.allows(Capability::MutateProject));
        assert!(!Grant::Conduct.allows(Capability::MutateAcross));
        assert!(Grant::Conduct.ensure(Capability::MutateAcross).is_err());
    }

    /// The refusal is what the agent reads, so it has to say what to do next
    /// rather than name a variant.
    #[test]
    fn every_refusal_is_a_sentence_an_agent_can_act_on() {
        for capability in [
            Capability::ReadProject,
            Capability::MutateProject,
            Capability::MutateAcross,
        ] {
            let refusal = capability.refusal();
            assert!(refusal.len() > 30, "{capability:?}");
            assert!(!refusal.contains("Capability"), "{capability:?}");
        }
    }
}
