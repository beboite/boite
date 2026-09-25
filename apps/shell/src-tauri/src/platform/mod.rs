//! OS integration. The shell's orchestration and IPC authorization stay in lib.rs.
mod paths;
pub(crate) use paths::default_data_dir;

#[cfg(windows)]
#[path = "windows_job.rs"]
pub(crate) mod job;
#[cfg(not(windows))]
#[path = "posix_job.rs"]
pub(crate) mod job;

#[cfg(windows)]
#[path = "windows_process.rs"]
pub(crate) mod process;
#[cfg(not(windows))]
#[path = "posix_process.rs"]
pub(crate) mod process;

#[cfg(windows)]
pub(crate) mod windows;
#[cfg(windows)]
pub(crate) use windows::{notify, prepare_command};
#[cfg(not(windows))]
mod posix;
#[cfg(not(windows))]
pub(crate) use posix::{notify, prepare_command};

pub(crate) mod appbars;
