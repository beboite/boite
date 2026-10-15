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
    /// started is its child and stays a zombie that `kill(pid, 0)` still finds
    /// until its `Child` is waited on, so its exit is read with `WNOWAIT`: the
    /// status stays for the `Child`, whose `wait` would fail with `ECHILD` once
    /// something else reaped it.
    pub fn exited_within(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if exited_child(self.0) || !alive_pid(self.0) {
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

/// Whether `pid` is a child of this process that exited, left unreaped.
/// `ECHILD` just means it is someone else's.
fn exited_child(pid: libc::pid_t) -> bool {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let options = libc::WEXITED | libc::WNOHANG | libc::WNOWAIT;
    // With WNOHANG and no exit yet, the call succeeds and leaves `info` zeroed.
    unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, options) == 0 && info.si_signo == libc::SIGCHLD }
}

fn alive_pid(pid: libc::pid_t) -> bool {
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Whether a process with this pid is still running. A child of this process
/// that exited counts until it is waited on: a caller holding its `Child`
/// calls `try_wait` first (`reap_child` in local_core/mod.rs).
pub fn alive(pid: u32) -> bool {
    libc::pid_t::try_from(pid).is_ok_and(|pid| pid > 0 && alive_pid(pid))
}

/// When the process wearing `pid` started, in milliseconds since the epoch,
/// to tell the core `core.json` named from a later process given its number.
/// `None` when it cannot be read.
#[cfg(target_os = "linux")]
pub fn started_at(pid: u32) -> Option<u64> {
    // Field 22 counts clock ticks since boot; the name before it, in
    // parentheses, may hold spaces, so fields are counted after the last ')'.
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let ticks: u64 = stat.rsplit_once(')')?.1.split_whitespace().nth(19)?.parse().ok()?;
    let boot: u64 = std::fs::read_to_string("/proc/stat").ok()?
        .lines().find_map(|line| line.strip_prefix("btime"))?.trim().parse().ok()?;
    let hertz = u64::try_from(unsafe { libc::sysconf(libc::_SC_CLK_TCK) }).ok().filter(|hertz| *hertz > 0)?;
    Some(boot * 1000 + ticks * 1000 / hertz)
}

#[cfg(target_os = "macos")]
pub fn started_at(pid: u32) -> Option<u64> {
    let pid = libc::c_int::try_from(pid).ok().filter(|pid| *pid > 0)?;
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).ok()?;
    let read = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
    (read == size).then(|| info.pbi_start_tvsec * 1000 + info.pbi_start_tvusec / 1000)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn started_at(_pid: u32) -> Option<u64> {
    None
}
