//! The Windows job object every process tree a boite spawns is put into.
//!
//! `KILL_ON_JOB_CLOSE` is the whole point: `TerminateJobObject` takes a child
//! and everything it spawned in one syscall (the `taskkill` shell-out it
//! replaced cost 0.5 to 2s per PTY and stalled app close), and a boite killed
//! without running its cleanup still leaves nothing behind, the OS closing the
//! handle and reaping the tree for it.
//!
//! It lives here rather than beside its first caller because three of them
//! want it: `pty` for a terminal's child, `boite-mcp --dev` for the dev window
//! it starts, and `boite-pilot` for an agent process. The pilot crate takes no
//! dependency on this one and keeps its own copy; nothing else does.
//!
//! **Only a pid captured at spawn is ever assigned to one.** Never a name,
//! never a pattern: this worktree's path and the word "boite" sit in the argv
//! of the user's own threads and of the app drawing them.

/// A job object holding one pid and its descendants.
///
/// Non-Windows targets get the same type with no behaviour, so a caller writes
/// one code path: there, a process group and a signal do this job and the
/// caller already has them.
#[cfg(target_os = "windows")]
pub struct Job(windows_sys::Win32::Foundation::HANDLE);

#[cfg(target_os = "windows")]
unsafe impl Send for Job {}
#[cfg(target_os = "windows")]
unsafe impl Sync for Job {}

#[cfg(target_os = "windows")]
impl Job {
    /// Create a job and put `pid` in it. `None` when the process is already
    /// gone or this process may not set its quota, which is a reason to fall
    /// back to killing the pid itself rather than to fail the spawn.
    pub fn assign(pid: u32) -> Option<Self> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                CloseHandle(job);
                return None;
            }
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                CloseHandle(job);
                return None;
            }
            let assigned = AssignProcessToJobObject(job, process);
            CloseHandle(process);
            if assigned == 0 {
                CloseHandle(job);
                return None;
            }
            Some(Self(job))
        }
    }

    /// Take the whole tree. `false` when the call itself failed, which leaves
    /// the handle valid and the drop below as the second chance.
    pub fn terminate(&self) -> bool {
        unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1) != 0 }
    }
}

#[cfg(target_os = "windows")]
impl Drop for Job {
    fn drop(&mut self) {
        // KILL_ON_JOB_CLOSE: closing the last handle is itself the kill, which
        // is what covers a boite that died without running any cleanup.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub struct Job;

/// Nothing to close. The impl exists so that a `drop(job)` at a call site
/// means the same thing on every platform: on Windows it is the kill, and
/// clippy on Linux would otherwise read the same line as dropping a value
/// that has nothing to drop (`drop_non_drop`).
#[cfg(not(target_os = "windows"))]
impl Drop for Job {
    fn drop(&mut self) {}
}

#[cfg(not(target_os = "windows"))]
impl Job {
    /// Always `None`: elsewhere a process group carries the tree and the
    /// caller signals it, so pretending to hold one would hide that path.
    pub fn assign(_pid: u32) -> Option<Self> {
        None
    }

    pub fn terminate(&self) -> bool {
        false
    }
}
