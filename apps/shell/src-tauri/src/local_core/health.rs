//! What `core.json` says and whether a running core answers as that core:
//! the file, the `/health` request and the verdict on its answer.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use super::CoreEndpoint;
use crate::platform;

pub(crate) const HEALTH_TIMEOUT: Duration = Duration::from_millis(500);

/// `<dataDir>/core.json`, written by the core on start.
#[derive(Deserialize)]
pub(crate) struct CoreFile {
    pub(crate) port: u16,
    #[serde(default)]
    host: Option<String>,
    pub(crate) token: String,
    #[serde(default)]
    pub(crate) pid: Option<u32>,
}

impl CoreFile {
    /// What tells one run of a core from another: a new run binds a new port
    /// under a new pid, so a `core.json` with the same pair is the same run.
    pub(super) fn identity(&self) -> (Option<u32>, u16) {
        (self.pid, self.port)
    }
}

pub(crate) fn read_core_file(path: &Path) -> Result<Option<CoreFile>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{} could not be read: {error}", path.display())),
    };
    serde_json::from_str::<CoreFile>(&text)
        .map(Some)
        .map_err(|error| {
            format!(
                "{} is not a core.json: expected {{ port, host, token, pid }}, {error}",
                path.display()
            )
        })
}

pub(super) fn endpoint_of(file: &CoreFile) -> CoreEndpoint {
    let host = match file.host.as_deref() {
        Some("0.0.0.0") | Some("::") | None => "127.0.0.1",
        Some(host) => host,
    };
    CoreEndpoint {
        url: format!("http://{host}:{}", file.port),
        token: file.token.clone(),
    }
}

/// The JSON body the real core answers `/health` with
/// (`packages/core/src/server.ts`: `{ ok, version, pid }`). `ok` and `pid`
/// say it is the core `core.json` described; `version` says whether it is this
/// install's core or the one an update left running.
#[derive(Deserialize)]
pub(crate) struct HealthBody {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    pid: Option<u32>,
}

/// What a `core.json` found at start turned out to be.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Probe {
    /// This shell's core, running: adopt it.
    Current,
    /// A core of another version, running: the one an update or a reinstall
    /// left behind, which has to stop before this shell starts its own.
    Stale(String),
    /// Nothing running answers as that core.
    Absent,
}

/// The pure half of `probe`: what a `/health` answer means to this shell.
fn judge(answer: Option<HealthBody>, version: &str) -> Probe {
    match answer {
        None => Probe::Absent,
        Some(body) if body.version.as_deref() == Some(version) => Probe::Current,
        Some(body) => Probe::Stale(body.version.unwrap_or_else(|| "(none)".to_string())),
    }
}

/// Whether the core `file` names is running, and whose it is. A pid that is
/// not running is `Absent` without a connection: after a reboot `core.json`
/// names a closed port, and Windows takes 2 s to refuse one, so `health`
/// would spend its whole timeout on it.
pub(super) fn probe(file: &CoreFile, version: &str) -> Probe {
    let Some(pid) = file.pid else { return Probe::Absent };
    if !platform::process::alive(pid) {
        return Probe::Absent;
    }
    judge(health(file.port, pid), version)
}

/// A bound on how much of a `/health` response is ever read, so a local
/// process that keeps the connection open and streams data cannot be used to
/// tie up the shell's startup past `HEALTH_TIMEOUT` with unbounded memory.
/// The real response is a small JSON object; this is generous over that.
const HEALTH_RESPONSE_LIMIT: usize = 8 * 1024;

/// A GET on `/health`, because one request does not deserve an HTTP crate.
/// The response is read to its end (or to `HEALTH_RESPONSE_LIMIT`, or until
/// `HEALTH_TIMEOUT` elapses) and handed to `health_response`, which is what
/// actually decides whether this is the core `core.json` described.
pub(crate) fn health(port: u16, expected_pid: u32) -> Option<HealthBody> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, HEALTH_TIMEOUT).ok()?;
    let _ = stream.set_read_timeout(Some(HEALTH_TIMEOUT));
    let _ = stream.set_write_timeout(Some(HEALTH_TIMEOUT));

    let request =
        format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;

    let mut response = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        if response.len() >= HEALTH_RESPONSE_LIMIT {
            break;
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => response.extend_from_slice(&chunk[..read]),
            Err(_) => break,
        }
    }
    health_response(&response, expected_pid)
}

/// The pure parse behind `health`, kept separate from the socket so a crafted
/// response can be checked without one. A response that is not a 200, that
/// carries no blank line ending its headers, whose body is not the JSON
/// `/health` answers with, or whose `pid` is not `expected_pid`, is never a
/// match: a local process squatting the port and merely echoing
/// `HTTP/1.1 200` gets none of these right unless it can also read
/// `core.json`, which is exactly what it is being asked to prove it can.
fn health_response(response: &[u8], expected_pid: u32) -> Option<HealthBody> {
    let text = String::from_utf8_lossy(response);
    if !(text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200")) {
        return None;
    }
    let body_start = text.find("\r\n\r\n")?;
    let body = &text[body_start + 4..];
    serde_json::from_str::<HealthBody>(body)
        .ok()
        .filter(|parsed| parsed.ok && parsed.pid == Some(expected_pid))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    // -----------------------------------------------------------------------
    // Finding 4 (security audit, 2026-09-12): `health` used to accept any
    // local listener that merely echoed `HTTP/1.1 200`. These are the four
    // cases the fix is required to tell apart, all through the pure parse
    // rather than a real socket.
    // -----------------------------------------------------------------------

    #[test]
    fn health_response_matches_the_real_core_body_with_the_matching_pid() {
        let response = b"HTTP/1.1 200 OK\r\ncontent-type: application/json;charset=utf-8\r\ncontent-length: 40\r\n\r\n{\"ok\":true,\"version\":\"2.0.0\",\"pid\":4242}";
        assert!(super::health_response(response, 4242).is_some());
    }

    #[test]
    fn health_response_refuses_a_body_naming_a_different_pid() {
        let response = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true,\"version\":\"2.0.0\",\"pid\":1}";
        assert!(super::health_response(response, 4242).is_none());
    }

    #[test]
    fn health_response_refuses_a_body_that_is_not_json() {
        let response = b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\nsquatting this port";
        assert!(super::health_response(response, 4242).is_none());
    }

    #[test]
    fn health_response_refuses_a_bare_200_with_no_body() {
        let response = b"HTTP/1.1 200 OK\r\n\r\n";
        assert!(super::health_response(response, 4242).is_none());
    }

    #[test]
    fn a_core_of_another_version_is_stale_and_a_silent_one_is_absent() {
        let body = |version: Option<&str>| HealthBody { ok: true, version: version.map(str::to_string), pid: Some(1) };
        assert_eq!(judge(Some(body(Some("2.0.0"))), "2.0.0"), Probe::Current);
        assert_eq!(judge(Some(body(Some("2.0.0-beta.1"))), "2.0.0"), Probe::Stale("2.0.0-beta.1".to_string()));
        assert_eq!(judge(Some(body(None)), "2.0.0"), Probe::Stale("(none)".to_string()));
        assert_eq!(judge(None, "2.0.0"), Probe::Absent);
        let response = b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"version\":\"1.9.0\",\"pid\":7}";
        assert_eq!(health_response(response, 7).and_then(|body| body.version).as_deref(), Some("1.9.0"));
    }

    #[test]
    fn a_core_json_naming_a_process_that_exited_costs_no_connection() {
        let _process_guard = crate::PROCESS_TEST_LOCK.lock().unwrap();
        let mut gone = Command::new("bun");
        gone.args(["-e", "0"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        platform::prepare_command(&mut gone);
        let mut gone = gone.spawn().unwrap();
        let pid = gone.id();
        gone.wait().unwrap();
        drop(gone);
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let file = CoreFile { port, host: None, token: "t".to_string(), pid: Some(pid) };
        let started = Instant::now();
        assert_eq!(probe(&file, "2.0.0"), Probe::Absent);
        // A refused connection alone takes HEALTH_TIMEOUT (500 ms) on Windows.
        assert!(started.elapsed() < Duration::from_millis(100), "probing a dead core took {:?}", started.elapsed());
    }
}
