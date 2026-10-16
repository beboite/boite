//! One process the shell did not start, named by the pid `core.json` gave.
use std::time::Duration;

use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

/// An open handle on the process. Holding it pins the pid: Windows cannot hand
/// the number to another process while a handle is open, so the wait and the
/// terminate below always reach the process that was opened.
pub struct Watched(HANDLE);

// A process handle is a kernel handle, valid from every thread.
unsafe impl Send for Watched {}

impl Drop for Watched {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

impl Watched {
    /// `None` when no process has that pid, or this account may not open it,
    /// which a core started by this user never is.
    pub fn open(pid: u32) -> Option<Self> {
        let access = PROCESS_SYNCHRONIZE | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION;
        let handle = unsafe { OpenProcess(access, 0, pid) };
        (!handle.is_null()).then(|| Self(handle))
    }

    /// Whether the process exited before `timeout` ran out.
    pub fn exited_within(&self, timeout: Duration) -> bool {
        let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
        unsafe { WaitForSingleObject(self.0, millis) == WAIT_OBJECT_0 }
    }

    /// Windows has no signal a windowless process can be sent to drain: the
    /// graceful path is `POST /shutdown`, and this says it was not taken.
    pub fn interrupt(&self) -> bool {
        false
    }

    /// Ends the process without letting it run another instruction.
    pub fn terminate(&self) {
        unsafe { TerminateProcess(self.0, 1) };
    }
}

/// Whether a process with this pid is still running. A pid that exited, or
/// that this account cannot open, answers false: no core of this user's is
/// behind it, so no connection to its port is worth attempting.
pub fn alive(pid: u32) -> bool {
    Watched::open(pid).is_some_and(|process| !process.exited_within(Duration::ZERO))
}

/// When the process wearing `pid` started, in milliseconds since the epoch,
/// to tell the core `core.json` named from a later process given its number.
/// `None` when no process has it or this account may not query it.
pub fn started_at(pid: u32) -> Option<u64> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    let read = unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
    unsafe { CloseHandle(handle) };
    if read == 0 {
        return None;
    }
    // 100 ns intervals since 1601-01-01; the epoch is 11,644,473,600 s later.
    let intervals = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    (intervals / 10_000).checked_sub(11_644_473_600_000)
}

/// Windows gives an absolute creation time, which `started_at` reads, so it
/// needs no key of its own to tell runs apart.
pub fn start_key(_pid: u32) -> Option<String> {
    None
}
