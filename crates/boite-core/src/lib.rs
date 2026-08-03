pub mod approval;
pub mod browser;
pub mod capability;
pub mod command;
pub mod editor;
pub mod env;
pub mod explorer;
pub mod fastpick;
pub mod finish;
pub mod git;
pub mod journal;
pub mod migrations;
pub mod model;
pub mod project;
pub mod pty;
pub mod scope;
pub mod screen;
pub mod search;
pub mod secret_file;
pub mod session;
pub mod shell;
pub mod snapshot;
pub mod status;
pub mod timeline;
pub mod transcript;
pub mod store;
pub mod usage;

/// Now, in milliseconds since the epoch.
///
/// One copy. There were six, each with its own `unwrap_or(0)` or `expect`, and
/// a clock before 1970 is not a case any of them meant to handle differently.
/// Zero on a system clock that far wrong, which sorts to the beginning of every
/// timeline rather than panicking inside a write.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
