//! Stopping the resident core this computer runs: before an update replaces
//! its files, and when the shell finds a core older than itself.
//!
//! A resident core outlives the shell, so no Job Object ties it to anything and
//! quitting the shell leaves it running. Whatever needs it gone asks it the way
//! an owner does, with the core token from `core.json`, and only kills the pid
//! that `core.json` named and `/health` confirmed. Never by executable name:
//! Boite Dev runs a `boite-core.exe` too, on its own data directory.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

use crate::local_core::health::{health, read_core_file, HEALTH_TIMEOUT};
use crate::platform::process::Watched;

/// What the core gets to drain its agents and close its journal. The core's
/// own deadline is 10 s (`SHUTDOWN_TIMEOUT_MS` in `packages/core/src/main.ts`).
pub const GRACE: Duration = Duration::from_secs(12);
/// How long a terminated process may take to disappear.
const KILL_WAIT: Duration = Duration::from_secs(3);

/// `POST /shutdown` with the core token. `Ok` once the core accepted; it exits
/// on its own after answering.
pub fn request_shutdown(port: u16, token: &str) -> Result<(), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, HEALTH_TIMEOUT)
        .map_err(|error| format!("no core answers on port {port}: {error}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let request = format!(
        "POST /shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("the stop request to port {port} could not be sent: {error}"))?;
    let mut head = [0u8; 64];
    let read = stream.read(&mut head).unwrap_or(0);
    let status = String::from_utf8_lossy(&head[..read]);
    let code = status.split_whitespace().nth(1).unwrap_or("(nothing)");
    if code == "202" || code == "200" {
        Ok(())
    } else {
        Err(format!("the core on port {port} refused to stop: HTTP {code}"))
    }
}

/// Stops the core `<directory>/core.json` names, if it is running and answers
/// as that core. `Ok(Some(pid))` once it is gone, `Ok(None)` when there was
/// nothing to stop, `Err` when a core is still there after `grace` and a kill.
pub fn stop_local_core(directory: &Path, grace: Duration) -> Result<Option<u32>, String> {
    let file = directory.join("core.json");
    let Some(core) = read_core_file(&file)? else { return Ok(None) };
    let Some(pid) = core.pid else { return Ok(None) };
    // Opened before anything is asked of it: from here on the pid cannot name
    // another process, even if this one exits and Windows reuses the number.
    let Some(process) = Watched::open(pid) else { return Ok(None) };
    if health(core.port, pid).is_none() {
        // A live pid that is not the core `core.json` described: a reused
        // number after a reboot, most likely. Not ours to stop.
        return Ok(None);
    }
    let asked = match request_shutdown(core.port, &core.token) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("[shell] {error}; stopping pid {pid} without its consent");
            // A POSIX core drains on SIGTERM as well; Windows has no signal.
            process.interrupt()
        }
    };
    if asked && process.exited_within(grace) {
        return Ok(Some(pid));
    }
    process.terminate();
    if process.exited_within(KILL_WAIT) {
        Ok(Some(pid))
    } else {
        Err(format!(
            "the core named by {} (pid {pid}) is still running after a stop request and a kill",
            file.display()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::process::{Command, Stdio};

    /// A stand-in core: answers `/health` with its own pid and exits on an
    /// authorised `POST /shutdown`, the two routes the stop relies on.
    const FAKE_CORE: &str = r#"
const token = process.argv[2];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/health') return Response.json({ ok: true, version: 'test', pid: process.pid });
  if (url.pathname === '/shutdown' && request.method === 'POST' && request.headers.get('authorization') === `Bearer ${token}`) {
    setTimeout(() => process.exit(0), 20);
    return Response.json({ ok: true }, { status: 202 });
  }
  return new Response('no', { status: 401 });
} });
console.log(server.port);
setInterval(() => {}, 1000);
"#;

    fn fake_core(directory: &Path, token: &str) -> std::process::Child {
        use std::io::BufRead;
        let script = directory.join("fake-core.ts");
        std::fs::write(&script, FAKE_CORE).unwrap();
        let mut command = Command::new("bun");
        command.arg(&script).arg(token).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        crate::platform::prepare_command(&mut command);
        let mut child = command.spawn().expect("bun runs the fake core");
        let mut line = String::new();
        std::io::BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let port: u16 = line.trim().parse().expect("the fake core prints its port");
        std::fs::write(
            directory.join("core.json"),
            format!(r#"{{"port":{port},"host":"127.0.0.1","token":"{token}","pid":{}}}"#, child.id()),
        )
        .unwrap();
        child
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!("boite-resident-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn a_resident_core_is_asked_to_stop_with_its_token_and_is_gone_after() {
        let _process_guard = crate::PROCESS_TEST_LOCK.lock().unwrap();
        let directory = scratch("stop");
        let mut child = fake_core(&directory, "secret-token");
        let pid = child.id();
        let stopped = stop_local_core(&directory, GRACE).expect("the stop succeeds");
        assert_eq!(stopped, Some(pid));
        // It exited on the request, with its own code, not a kill.
        assert_eq!(child.wait().unwrap().code(), Some(0));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_core_json_naming_nothing_alive_is_nothing_to_stop() {
        let directory = scratch("dead");
        // A port nothing listens on, a pid no process has.
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        std::fs::write(directory.join("core.json"), format!(r#"{{"port":{port},"token":"t","pid":4294967290}}"#)).unwrap();
        assert_eq!(stop_local_core(&directory, GRACE).unwrap(), None);
        std::fs::remove_file(directory.join("core.json")).unwrap();
        assert_eq!(stop_local_core(&directory, GRACE).unwrap(), None);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_live_pid_that_does_not_answer_as_the_core_is_left_alone() {
        let _process_guard = crate::PROCESS_TEST_LOCK.lock().unwrap();
        let directory = scratch("squat");
        let mut other = Command::new("bun");
        other.args(["-e", "setInterval(() => {}, 1000)"]).stdin(Stdio::null()).stdout(Stdio::null());
        crate::platform::prepare_command(&mut other);
        let mut other = other.spawn().unwrap();
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        std::fs::write(directory.join("core.json"), format!(r#"{{"port":{port},"token":"t","pid":{}}}"#, other.id())).unwrap();
        assert_eq!(stop_local_core(&directory, GRACE).unwrap(), None);
        assert!(matches!(other.try_wait(), Ok(None)), "a process that is not the core was stopped");
        let _ = other.kill();
        let _ = other.wait();
        std::fs::remove_dir_all(directory).unwrap();
    }
}
