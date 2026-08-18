use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_INTERVAL_MS: u128 = 5 * 60 * 1000;

pub fn run(provider: &str) -> i32 {
    let claimed = crate::lock::locked(crate::lock::MIDTASK, || {
        let stamp = stamp_file();
        if !due(&stamp) {
            return false;
        }
        let _ = std::fs::write(&stamp, now_ms().to_string());
        true
    });
    if claimed == Ok(true) {
        spawn(provider);
    }
    0
}

fn stamp_file() -> PathBuf {
    crate::provider::state_dir().join("midtask.stamp")
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn interval_ms() -> u128 {
    std::env::var("KEBACC_SWITCH_MIDTASK_INTERVAL_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u128>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_INTERVAL_MS)
}

fn due(stamp: &PathBuf) -> bool {
    let Some(last) = std::fs::read_to_string(stamp)
        .ok()
        .and_then(|text| text.trim().parse::<u128>().ok())
    else {
        return true;
    };
    let now = now_ms();
    last > now || now - last >= interval_ms()
}

fn spawn(provider: &str) {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let mut command = Command::new(exe);
    command
        .args(["auto", "-Provider", provider, "-Hook", "-Spawned"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    detach(&mut command);
    let _ = command.spawn();
}

#[cfg(windows)]
pub fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn detach(_command: &mut Command) {}
