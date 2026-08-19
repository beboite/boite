//! What an orchestrator thread is, apart from the terminal it runs in.
//!
//! An orchestrator is an ordinary thread with `role = "orchestrator"` stamped
//! on its row by Boite at creation. Everything special about it hangs off that
//! stamp: the MCP tool tier it is handed, the `Grant::Conduct` its calls carry,
//! and the chat surface the user talks to it through. The stamp itself is not
//! claimable — see `crate::command::records` for the write rules.
//!
//! This module holds what is shared between the hosts: the briefing a restarted
//! session opens with. The wake decision (`wake.rs`) and the dispatch queue
//! (`dispatch.rs`) arrive with their own phases.

pub mod briefing;

/// The one value `role` ever holds. A constant so a typo is a compile error
/// rather than a thread that silently is not one.
pub const ROLE: &str = "orchestrator";
