//! An update hands the running turns to the next core: each one ends the tool call it is in,
//! 30 seconds at most, stops, and resumes after the restart. A core too old for that handoff
//! keeps the earlier rule: it stays usable until it grants an idle stop.
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use crate::local_core::health::{health, read_core_file, HEALTH_TIMEOUT};
use crate::platform::process::Watched;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum InstallState { Idle, Waiting, Cancelled, Committed }

/// The core's grace for a tool call (30 s), its deadline for a turn that ignores its stop (12 s)
/// and its own shutdown, with a margin.
pub(crate) const HANDOFF_EXIT: Duration = Duration::from_secs(60);

enum Admission { Accepted, Busy, Unsupported }

/// Only the exact process that was probed may accept the stop. Older cores fail closed.
fn request_shutdown(path: &str, port: u16, token: &str, pid: u32) -> Result<Admission, String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, HEALTH_TIMEOUT).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(3))).map_err(|e| e.to_string())?;
    write!(stream, "POST {path}?pid={pid} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").map_err(|e| e.to_string())?;
    let mut response = String::new();
    stream.take(16 * 1024).read_to_string(&mut response).map_err(|e| e.to_string())?;
    let code = response.split_whitespace().nth(1).unwrap_or("missing");
    if code == "409" { return Ok(Admission::Busy); }
    if code == "404" { return Ok(Admission::Unsupported); }
    if code != "202" { return Err(format!("the engine refused safe update admission (HTTP {code}); stop it explicitly before installing")); }
    let body = response.split_once("\r\n\r\n").map(|(_, body)| body).unwrap_or("");
    let value: serde_json::Value = serde_json::from_str(body).map_err(|e| format!("invalid update admission: {e}"))?;
    if value.get("ok").and_then(|v| v.as_bool()) != Some(true) || value.get("pid").and_then(|v| v.as_u64()) != Some(pid as u64) {
        return Err("update admission must acknowledge the probed core pid".into());
    }
    Ok(Admission::Accepted)
}

/// Cancellation and each admission request share the mutex. Once committed, cancellation is too late.
/// A core with the handoff commits on the first request, busy or not; an older one is polled until idle.
pub(crate) fn stop_for_update(directory: &Path, control: &Mutex<InstallState>, committed: impl Fn()) -> Result<bool, String> {
    let core = read_core_file(&directory.join("core.json"))?.ok_or("core.json is missing; nothing was installed")?;
    let pid = core.pid.ok_or("core.json must identify the core pid; nothing was installed")?;
    let process = Watched::open(pid).ok_or("the expected core process could not be watched; nothing was installed")?;
    let mut handoff = true;
    loop {
        let mut state = control.lock().map_err(|_| "update admission state is poisoned")?;
        if *state == InstallState::Cancelled { return Ok(false); }
        if !process.exited_within(Duration::ZERO) {
            if health(core.port, pid).is_none() { return Err("the live engine did not answer as the expected core; nothing was installed".into()); }
            if handoff {
                match request_shutdown("/shutdown-for-update", core.port, &core.token, pid)? {
                    Admission::Accepted => {}
                    _ => { handoff = false; continue; }
                }
            } else {
                match request_shutdown("/shutdown-if-idle", core.port, &core.token, pid)? {
                    Admission::Accepted => {}
                    Admission::Busy => {
                        drop(state);
                        std::thread::sleep(Duration::from_millis(250));
                        continue;
                    }
                    Admission::Unsupported => return Err("the engine refused safe update admission (HTTP 404); stop it explicitly before installing".into()),
                }
            }
        }
        *state = InstallState::Committed;
        committed();
        drop(state);
        if !process.exited_within(if handoff { HANDOFF_EXIT } else { crate::resident::GRACE }) {
            return Err("the engine accepted the update but did not exit; nothing was installed".into());
        }
        return Ok(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};
    use std::sync::Arc;

    const SCRIPT: &str = r#"
import { existsSync } from 'node:fs';
const [dir, mode] = process.argv.slice(2);
const server = Bun.serve({ hostname:'127.0.0.1', port:0, fetch(request) {
 const url = new URL(request.url);
 if (url.pathname === '/health') return Response.json({ok:true,pid:process.pid,version:'test'});
 if (url.pathname === '/shutdown-for-update') {
  if (mode !== 'handoff') return new Response('missing',{status:404});
  setTimeout(() => process.exit(0),300);
  return Response.json({ok:true,pid:process.pid},{status:202});
 }
 if (url.pathname === '/shutdown-if-idle') {
  if (mode === 'legacy') return new Response('missing',{status:404});
  if (!existsSync(`${dir}/idle`)) return new Response('busy',{status:409});
  setTimeout(() => process.exit(0),30);
  return Response.json({ok:true,pid:process.pid},{status:202});
 }
 return new Response('no',{status:404});
}}); console.log(server.port);
"#;

    struct Fixture { child: Child, directory: std::path::PathBuf }
    impl Fixture {
        fn new(name: &str, mode: &str) -> Self {
            let directory = std::env::temp_dir().join(format!("boite-update-{name}-{}", std::process::id()));
            std::fs::create_dir_all(&directory).unwrap();
            let script = directory.join("core.ts"); std::fs::write(&script, SCRIPT).unwrap();
            let _ = std::fs::remove_file(directory.join("idle"));
            let mut command = Command::new("bun");
            command.arg(&script).arg(&directory).arg(mode).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
            crate::platform::prepare_command(&mut command);
            let mut child = command.spawn().unwrap();
            let mut port = String::new(); BufReader::new(child.stdout.take().unwrap()).read_line(&mut port).unwrap();
            std::fs::write(directory.join("core.json"), format!(r#"{{"pid":{},"port":{},"token":"fixture"}}"#, child.id(), port.trim())).unwrap();
            Self { child, directory }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); let _ = std::fs::remove_dir_all(&self.directory); }
    }
    #[test]
    fn a_busy_core_with_the_handoff_stops_on_the_first_request() {
        let _guard = crate::process_test_guard();
        let mut fixture = Fixture::new("handoff", "handoff");
        let control = Mutex::new(InstallState::Waiting);
        // No `idle` file: the idle admission would answer busy for ever.
        assert!(stop_for_update(&fixture.directory, &control, || {}).unwrap());
        assert_eq!(fixture.child.wait().unwrap().code(), Some(0));
        assert!(*control.lock().unwrap() == InstallState::Committed);
    }
    #[test]
    fn cancellation_leaves_a_busy_core_running() {
        let _guard = crate::process_test_guard();
        let mut fixture = Fixture::new("cancel", "current");
        let control = Arc::new(Mutex::new(InstallState::Waiting));
        let other = control.clone(); let directory = fixture.directory.clone();
        let waiter = std::thread::spawn(move || stop_for_update(&directory, &other, || panic!("cancelled install committed")));
        std::thread::sleep(Duration::from_millis(100));
        *control.lock().unwrap() = InstallState::Cancelled;
        assert!(!waiter.join().unwrap().unwrap());
        assert!(fixture.child.try_wait().unwrap().is_none());
    }
    #[test]
    fn busy_work_finishes_before_the_core_exits_on_its_own() {
        let _guard = crate::process_test_guard();
        let mut fixture = Fixture::new("finish", "current");
        let control = Arc::new(Mutex::new(InstallState::Waiting));
        let other = control.clone(); let directory = fixture.directory.clone();
        let waiter = std::thread::spawn(move || stop_for_update(&directory, &other, || {}));
        std::thread::sleep(Duration::from_millis(100));
        assert!(fixture.child.try_wait().unwrap().is_none());
        std::fs::write(fixture.directory.join("idle"), "").unwrap();
        assert!(waiter.join().unwrap().unwrap());
        assert_eq!(fixture.child.wait().unwrap().code(), Some(0));
        assert!(*control.lock().unwrap() == InstallState::Committed);
    }
    #[test]
    fn an_older_core_without_idle_admission_is_never_killed() {
        let _guard = crate::process_test_guard();
        let mut fixture = Fixture::new("legacy", "legacy");
        let control = Mutex::new(InstallState::Waiting);
        assert!(stop_for_update(&fixture.directory, &control, || {}).unwrap_err().contains("404"));
        assert!(fixture.child.try_wait().unwrap().is_none());
    }
}
