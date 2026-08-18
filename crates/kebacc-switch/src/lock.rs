#[cfg(not(windows))]
use std::path::{Path, PathBuf};
use std::time::Duration;
#[cfg(not(windows))]
use std::time::Instant;

pub const CRED_SWAP: &str = "KebaccSwitchCredentialSwap";
pub const USAGE_CACHE: &str = "KebaccSwitchUsageCache";
pub const UPDATE: &str = "KebaccSwitchUpdate";

const WAIT: Duration = Duration::from_secs(15);

pub struct Guard {
    #[cfg(windows)]
    handle: isize,
    #[cfg(not(windows))]
    dir: PathBuf,
}

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
        return Err("Could not take the switch lock.".into());
    }
    let waited = unsafe { WaitForSingleObject(handle, WAIT.as_millis() as u32) };
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
    let dir = crate::provider::state_dir().join(format!("{name}.lock"));
    let start = Instant::now();
    loop {
        match std::fs::create_dir(&dir) {
            Ok(()) => {
                if let Err(problem) = std::fs::write(dir.join("pid"), std::process::id().to_string())
                {
                    let _ = std::fs::remove_dir_all(&dir);
                    return Err(format!("Could not take the switch lock: {problem}"));
                }
                return Ok(Guard { dir });
            }
            Err(_) if start.elapsed() < WAIT => {
                if !holder_alive(&dir) {
                    let _ = std::fs::remove_dir_all(&dir);
                    continue;
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
fn holder_alive(dir: &Path) -> bool {
    match std::fs::read_to_string(dir.join("pid")) {
        Ok(text) => text
            .trim()
            .parse::<i32>()
            .ok()
            .filter(|pid| *pid > 0)
            .is_some_and(pid_alive),
        // The creator writes the pid right after mkdir. A missing file that is
        // still young is that write, not a leftover empty dir.
        Err(_) => std::fs::metadata(dir)
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|when| when.elapsed().ok())
            .is_some_and(|age| age < Duration::from_secs(2)),
    }
}

#[cfg(not(windows))]
fn pid_alive(pid: i32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
