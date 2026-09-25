//! One process the shell did not necessarily start, named by the pid `core.json` gave.
use std::time::{Duration, Instant};

/// POSIX has no process handle to hold, so the pid is the identity. The
/// caller has just seen that pid answer `/health` with its own number.
pub struct Watched(libc::pid_t);

impl Watched {
    pub fn open(pid: u32) -> Option<Self> {
        let pid = libc::pid_t::try_from(pid).ok().filter(|pid| *pid > 0)?;
        alive_pid(pid).then_some(Self(pid))
    }

    /// Whether the process exited before `timeout` ran out. A core this shell
    /// started is its child and would stay a zombie that `kill(pid, 0)` still
    /// finds, so it is reaped here; `ECHILD` just means it is someone else's.
    pub fn exited_within(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if unsafe { libc::waitpid(self.0, std::ptr::null_mut(), libc::WNOHANG) } == self.0 || !alive_pid(self.0) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// SIGTERM, which the core handles like `core.shutdown`.
    pub fn interrupt(&self) -> bool {
        unsafe { libc::kill(self.0, libc::SIGTERM) == 0 }
    }

    pub fn terminate(&self) {
        unsafe { libc::kill(self.0, libc::SIGKILL) };
    }
}

fn alive_pid(pid: libc::pid_t) -> bool {
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Whether a process with this pid is still running.
pub fn alive(pid: u32) -> bool {
    libc::pid_t::try_from(pid).is_ok_and(|pid| pid > 0 && alive_pid(pid))
}
