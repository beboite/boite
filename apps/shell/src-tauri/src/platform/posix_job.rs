//! Clean shutdown kills the direct core child. Hard shell exits have no kernel ownership yet.
use std::process::Child;

pub struct CoreJob;

pub fn create_core_job() -> Result<CoreJob, String> {
    Ok(CoreJob)
}

pub fn assign(_job: &CoreJob, _child: &Child) -> Result<(), String> {
    Ok(())
}

/// Let the core flush its journal and stop its agents before forcing an exit.
pub fn stop_core(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) { return; }
    // This unreaped child belongs to the shell, so its PID cannot be reused.
    unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM); }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) { return; }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    #[test]
    fn clean_shutdown_delivers_term_before_kill() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "trap 'exit 0' TERM; echo ready; read line"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut ready).unwrap();
        assert_eq!(ready.trim(), "ready");
        super::stop_core(&mut child);
        assert_eq!(child.wait().unwrap().code(), Some(0));
    }
}
