//! The Tauri commands, which is this app's front door.
//!
//! One file per surface, and every one of them is thin on purpose. The git,
//! worktree, filesystem and session capabilities are `boite_core::command`, so
//! what is left here is naming a command, handing over the arguments the webview
//! sent, and putting it through [`bus::through`]. The trust boundary, the work
//! and the refusals are all one layer down.
//!
//! - [`pty`] is the exception, and the reason there is one: a PTY is a process
//!   this app owns, with a channel to the webview and a scrollback the bus has
//!   no vocabulary for.
//! - [`files`], [`git`], [`sessions`] and [`records`] are codecs over the bus.
//!   [`records`] is the newest and replaces nothing on this side: the rows it
//!   answers for were read by the webview in raw SQL, so this half of the schema
//!   had no Rust reader while the server had fifteen arms over the same tables.
//! - [`agents`] is how an agent gets wired to Boite in the first place, which is
//!   config files on disk rather than anything the bus answers for.
//! - [`app`] is what only this process can say: its own log, its boot, and the
//!   snapshot.
//!
//! `bus` holds the host the four codecs share. It is the whole reason a command
//! here is three lines: [`bus::DesktopHost`] answers what a command may reach,
//! and nothing above it re-applies the check.

// `pub` because `#[tauri::command]` generates a sibling macro per command and
// `generate_handler!` resolves it by path. A glob re-export carries the function
// and leaves the macro behind, so the handler list names the module.
pub mod agents;
pub mod app;
mod bus;
pub mod checkpoint;
pub mod files;
pub mod git;
pub mod pty;
pub mod records;
pub mod sessions;

// The one type outside this module that a command's shape is part of: the PTY
// sink writes it, and the webview's xterm bridge reads it.
pub use pty::WirePtyEvent;
