//! The three HTTP requests this module makes, and nothing else.
//!
//! `boite-core` takes no async runtime and this does not change that:
//! `reqwest::blocking` runs its own reactor on a thread of its own, and every
//! call here blocks the thread the job owns. The bus never sees it — an install
//! runs on a detached thread and the panel reads snapshots (see [`super::jobs`]).
//!
//! rustls with the bundled roots, the same TLS stack `tauri-plugin-updater`
//! already pulls in, so a boite carries one and not two.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use super::catalog::Algo;
use super::Failed;

/// A text answer nobody reads past: a version pointer is one line, a release
/// listing is JSON with a few hundred assets in it at most. A body without an
/// end is otherwise a download into memory.
const MAX_TEXT: u64 = 4 * 1024 * 1024;

/// An artifact nothing sane exceeds. Claude's binary is ~290 MB, so the ceiling
/// is high; it exists to stop a redirect to something else entirely, not to
/// second-guess a vendor.
const MAX_ARTIFACT: u64 = 1024 * 1024 * 1024;

/// How big a bite is taken off the socket, and therefore how often progress moves
/// and cancellation is noticed.
const CHUNK: usize = 64 * 1024;

fn build(configure: impl FnOnce(reqwest::blocking::ClientBuilder) -> reqwest::blocking::ClientBuilder) -> Result<reqwest::blocking::Client, Failed> {
    configure(
        reqwest::blocking::Client::builder()
            .user_agent(concat!("boite/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(15)),
    )
    .build()
    .map_err(|e| Failed(format!("no HTTP client: {e}")))
}

/// For a version pointer or a release listing: a whole request, quickly, or not
/// at all. Nothing here is worth waiting on.
fn small_client() -> Result<reqwest::blocking::Client, Failed> {
    build(|builder| builder.timeout(std::time::Duration::from_secs(30)))
}

/// For an artifact.
///
/// **No total timeout.** Claude's binary is ~290 MB, and any ceiling wide enough
/// for that on a slow line is not a ceiling — it is a number that fails the
/// install of whoever is on the slowest connection. Keepalive is what notices a
/// socket that died without saying so, and the job's cancel flag is what a user
/// who is done waiting reaches for.
fn artifact_client() -> Result<reqwest::blocking::Client, Failed> {
    build(|builder| builder.tcp_keepalive(std::time::Duration::from_secs(30)))
}

fn ok_or_status(response: reqwest::blocking::Response, url: &str) -> Result<reqwest::blocking::Response, Failed> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(Failed(format!("nothing published at {url}")));
    }
    Err(Failed(format!("{url} answered {status}")))
}

/// A bounded text body.
pub fn text(url: &str) -> Result<String, Failed> {
    let response = ok_or_status(
        small_client()?
            .get(url)
            .send()
            .map_err(|e| Failed(format!("{url} unreachable: {e}")))?,
        url,
    )?;
    let mut body = String::new();
    response
        .take(MAX_TEXT)
        .read_to_string(&mut body)
        .map_err(|e| Failed(format!("{url} answered something unreadable: {e}")))?;
    Ok(body)
}

/// A bounded JSON body, parsed.
pub fn json(url: &str) -> Result<serde_json::Value, Failed> {
    let body = text(url)?;
    serde_json::from_str(&body).map_err(|e| Failed(format!("{url} is not JSON: {e}")))
}

/// Streams `url` into `dest`, calling `progress(received, total)` as it goes and
/// giving up the moment `cancel` is set.
///
/// The partial file is removed on both failure and cancellation. A half-written
/// binary left in place reads as an install that worked, and the next launch is
/// what finds out otherwise.
pub fn download(
    url: &str,
    dest: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<(), Failed> {
    let response = ok_or_status(
        artifact_client()?
            .get(url)
            .send()
            .map_err(|e| Failed(format!("{url} unreachable: {e}")))?,
        url,
    )?;
    let total = response.content_length();
    if let Some(total) = total {
        if total > MAX_ARTIFACT {
            return Err(Failed(format!(
                "{url} offers {total} bytes, which is not a CLI"
            )));
        }
    }

    let outcome = stream_to_file(response, dest, total, cancel, &mut progress);
    if outcome.is_err() {
        let _ = std::fs::remove_file(dest);
    }
    outcome
}

fn stream_to_file(
    mut response: reqwest::blocking::Response,
    dest: &Path,
    total: Option<u64>,
    cancel: &AtomicBool,
    progress: &mut impl FnMut(u64, Option<u64>),
) -> Result<(), Failed> {
    let mut file = std::fs::File::create(dest)
        .map_err(|e| Failed(format!("cannot write {}: {e}", dest.display())))?;
    let mut buffer = vec![0u8; CHUNK];
    let mut received: u64 = 0;
    progress(0, total);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(Failed(super::CANCELLED.to_string()));
        }
        let read = response
            .read(&mut buffer)
            .map_err(|e| Failed(format!("the download stopped: {e}")))?;
        if read == 0 {
            break;
        }
        received += read as u64;
        if received > MAX_ARTIFACT {
            return Err(Failed("the download outgrew what a CLI can be".to_string()));
        }
        file.write_all(&buffer[..read])
            .map_err(|e| Failed(format!("cannot write {}: {e}", dest.display())))?;
        progress(received, total);
    }
    file.sync_all()
        .map_err(|e| Failed(format!("cannot flush {}: {e}", dest.display())))?;
    Ok(())
}

/// The digest of a file, lowercase hex, read in chunks so a 300 MB binary is not
/// a 300 MB allocation.
///
/// Which hash is the vendor's choice rather than this module's: one publishes a
/// sha256 manifest and another a sha512, and running the wrong one over the right
/// file is a mismatch that reads as a compromised download.
pub fn digest(path: &Path, algo: Algo) -> Result<String, Failed> {
    use sha2::{Digest, Sha256, Sha512};

    let mut file = std::fs::File::open(path)
        .map_err(|e| Failed(format!("cannot read {}: {e}", path.display())))?;
    let mut sha256 = Sha256::new();
    let mut sha512 = Sha512::new();
    let mut buffer = vec![0u8; CHUNK];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| Failed(format!("cannot read {}: {e}", path.display())))?;
        if read == 0 {
            break;
        }
        match algo {
            Algo::Sha256 => sha256.update(&buffer[..read]),
            Algo::Sha512 => sha512.update(&buffer[..read]),
        }
    }
    let hex = |bytes: &[u8]| -> String { bytes.iter().map(|byte| format!("{byte:02x}")).collect() };
    Ok(match algo {
        Algo::Sha256 => hex(&sha256.finalize()),
        Algo::Sha512 => hex(&sha512.finalize()),
    })
}
