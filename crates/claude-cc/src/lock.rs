//! Work that must not interleave with the same work in another process.
//!
//! Two commands swapping credentials at once would leave the CLI holding one
//! account's tokens under another account's email. On Windows this is the same
//! named mutex the PowerShell version took, so the two can be installed side by
//! side during an upgrade and still exclude each other. Elsewhere it is a lock
//! directory, which is atomic on every filesystem that matters here.

#[cfg(not(windows))]
use std::path::PathBuf;
use std::time::Duration;
#[cfg(not(windows))]
use std::time::Instant;

pub const CRED_SWAP: &str = "ClaudeCcCredentialSwap";
pub const USAGE_CACHE: &str = "ClaudeCcUsageCache";

const WAIT: Duration = Duration::from_secs(15);

pub struct Guard {
    #[cfg(windows)]
    handle: isize,
    #[cfg(not(windows))]
    dir: PathBuf,
}

/// Runs `body` while holding the named lock. A lock that cannot be taken within
/// fifteen seconds is an error rather than a silent second writer.
pub fn locked<T>(name: &str, body: impl FnOnce() -> T) -> Result<T, String> {
    let guard = acquire(name)?;
    let out = body();
    drop(guard);
    Ok(out)
}

#[cfg(windows)]
fn acquire(name: &str) -> Result<Guard, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};

    let wide: Vec<u16> = format!("Global\\{name}")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
    if handle.is_null() {
        // No mutex means no exclusion, and the alternative is refusing to work
        // at all. A session-local name would not exclude anything either.
        return Err("Could not take the switch lock.".into());
    }
    let waited = unsafe { WaitForSingleObject(handle, WAIT.as_millis() as u32) };
    // An abandoned mutex is one whose holder died mid-swap: this process owns it
    // now, which is exactly what it asked for.
    if waited != WAIT_OBJECT_0 && waited != WAIT_ABANDONED {
        unsafe { CloseHandle(handle) };
        return Err("Another account switch is in progress. Try again in a moment.".into());
    }
    Ok(Guard {
        handle: handle as isize,
    })
}

#[cfg(windows)]
impl Drop for Guard {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::ReleaseMutex;
        unsafe {
            ReleaseMutex(self.handle as *mut std::ffi::c_void);
            CloseHandle(self.handle as *mut std::ffi::c_void);
        }
    }
}

#[cfg(not(windows))]
fn acquire(name: &str) -> Result<Guard, String> {
    let dir = std::env::temp_dir().join(format!("{name}.lock"));
    let start = Instant::now();
    loop {
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(Guard { dir }),
            Err(_) if start.elapsed() < WAIT => {
                // A lock left behind by a process that died is worse than no
                // lock: it would wedge every later run.
                if let Ok(meta) = std::fs::metadata(&dir) {
                    if let Ok(age) = meta.modified().and_then(|m| m.elapsed()) {
                        if age > Duration::from_secs(60) {
                            let _ = std::fs::remove_dir(&dir);
                            continue;
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => {
                return Err("Another account switch is in progress. Try again in a moment.".into())
            }
        }
    }
}

#[cfg(not(windows))]
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.dir);
    }
}
