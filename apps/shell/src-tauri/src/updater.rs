//! Signed desktop updates. These commands never update a connected remote core.
use std::{path::PathBuf, sync::{atomic::{AtomicBool, Ordering}, Mutex}, time::{Duration, Instant}};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State, Webview};
use tauri_plugin_updater::{Update, UpdaterExt};
use sha2::{Digest, Sha256};

const RELEASES: &str = "https://api.github.com/repos/beboite/boite/releases";
const DOWNLOADS: &str = "https://github.com/beboite/boite/releases/download/";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Track { Stable, Nightly }
impl Track {
    fn of(version: &str) -> Self {
        if version.contains("-nightly.") { Self::Nightly } else { Self::Stable }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    phase: String,
    current_version: String,
    current_channel: Track,
    channel: Track,
    version: Option<String>,
    notes: Option<String>,
    published_at: Option<String>,
    received: u64,
    total: Option<u64>,
    error: Option<String>,
    supported: bool,
}

struct Pending { update: Update, path: Option<PathBuf>, digest: Option<[u8; 32]> }
impl Drop for Pending {
    fn drop(&mut self) { if let Some(path) = &self.path { let _ = std::fs::remove_file(path); } }
}
pub struct AppUpdater {
    snapshot: Mutex<Snapshot>,
    pending: Mutex<Option<Pending>>,
    busy: AtomicBool,
    preference: PathBuf,
    cache: PathBuf,
}
struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> { fn drop(&mut self) { self.0.store(false, Ordering::Release); } }

impl AppUpdater {
    pub fn new(version: String, directory: PathBuf, supported: bool) -> Self {
        let current_channel = Track::of(&version);
        let preference = directory.join("update-channel.json");
        let mut error = None;
        let channel = match std::fs::read(&preference) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(track) => track,
                Err(e) => { error = Some(format!("{}: expected stable or nightly: {e}", preference.display())); current_channel }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => current_channel,
            Err(e) => { error = Some(format!("{}: {e}", preference.display())); current_channel }
        };
        let cache = directory.join("pending-update.bin");
        // A process-local Update handle owns the verified payload. A crashed
        // previous process cannot leave an installable, unverified cache behind.
        let _ = std::fs::remove_file(&cache);
        Self { snapshot: Mutex::new(Snapshot {
            phase: if error.is_some() { "error" } else { "idle" }.into(), current_version: version,
            current_channel, channel, version: None, notes: None, published_at: None,
            received: 0, total: None, error, supported,
        }), pending: Mutex::new(None), busy: AtomicBool::new(false), preference, cache }
    }
    fn begin(&self) -> Result<Operation<'_>, String> {
        if !self.snapshot.lock().unwrap().supported { return Err("Updates require an installed Windows x64 build of Boite".into()); }
        self.busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "An app update operation is already running".to_string())?;
        Ok(Operation(&self.busy))
    }
    fn change(&self, app: &AppHandle, f: impl FnOnce(&mut Snapshot)) -> Snapshot {
        let snapshot = { let mut state = self.snapshot.lock().unwrap(); f(&mut state); state.clone() };
        let _ = app.emit_to(crate::browser::MAIN_LABEL, "app-update", &snapshot);
        snapshot
    }
    fn fail(&self, app: &AppHandle, error: String) -> Snapshot {
        self.pending.lock().unwrap().take();
        self.change(app, |s| { s.phase = "error".into(); s.error = Some(error); })
    }
}

#[derive(Deserialize)]
struct Asset { name: String, browser_download_url: String }
#[derive(Deserialize)]
struct Release { tag_name: String, draft: bool, assets: Vec<Asset>, published_at: Option<String>, body: Option<String> }

fn candidate(releases: &[Release], track: Track) -> Option<&Release> {
    releases.iter().filter(|r| !r.draft && Track::of(&r.tag_name) == track
        && r.assets.iter().any(|a| a.name == "latest.json"))
        .filter_map(|r| semver::Version::parse(r.tag_name.trim_start_matches('v')).ok().map(|v| (v, r)))
        .max_by(|a, b| a.0.cmp(&b.0)).map(|(_, r)| r)
}

async fn find_release(track: Track) -> Result<Release, String> {
    let client = reqwest::Client::builder().user_agent("boite-desktop-updater")
        .timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    for page in 1..=10 {
        let releases: Vec<Release> = client.get(format!("{RELEASES}?per_page=100&page={page}"))
            .send().await.map_err(|e| format!("Release lookup failed: {e}"))?
            .error_for_status().map_err(|e| format!("Release lookup failed: {e}"))?
            .json().await.map_err(|e| format!("Invalid release list: {e}"))?;
        if let Some(selected) = candidate(&releases, track) {
            let tag = selected.tag_name.clone();
            return Ok(releases.into_iter().find(|r| r.tag_name == tag).unwrap());
        }
        if releases.len() < 100 { break; }
    }
    Err(format!("No signed {track:?} desktop release is published yet"))
}

fn release_asset_url(release: &Release) -> Result<&str, String> {
    let asset = release.assets.iter().find(|a| a.name == "latest.json").ok_or("Release is missing latest.json")?;
    let expected = format!("{DOWNLOADS}{}/latest.json", release.tag_name);
    if asset.browser_download_url != expected { return Err(format!("latest.json URL must equal {expected}")); }
    Ok(&asset.browser_download_url)
}

fn offer_version(current: &semver::Version, next: &semver::Version, track: Track) -> bool {
    Track::of(&next.to_string()) == track &&
        if Track::of(&current.to_string()) != track { next != current } else { next > current }
}

#[tauri::command]
pub fn app_update_status(webview: Webview, state: State<'_, AppUpdater>) -> Result<Snapshot, String> {
    crate::browser::only_main(&webview)?;
    Ok(state.snapshot.lock().unwrap().clone())
}

#[tauri::command]
pub async fn app_update_check(webview: Webview, app: AppHandle, state: State<'_, AppUpdater>, channel: Track) -> Result<Snapshot, String> {
    crate::browser::only_main(&webview)?;
    let _operation = state.begin()?;
    state.pending.lock().unwrap().take();
    state.change(&app, |s| { s.phase = "checking".into(); s.channel = channel; s.error = None;
        s.version = None; s.notes = None; s.published_at = None; s.received = 0; s.total = None; });
    let result = async {
        let temporary = state.preference.with_extension("tmp");
        std::fs::write(&temporary, serde_json::to_vec(&channel).unwrap()).map_err(|e| format!("Cannot save update channel: {e}"))?;
        std::fs::rename(temporary, &state.preference).map_err(|e| format!("Cannot save update channel: {e}"))?;
        let release = find_release(channel).await?;
        let endpoint = release_asset_url(&release)?.parse().map_err(|e| format!("Invalid manifest URL: {e}"))?;
        let update = app.updater_builder().endpoints(vec![endpoint]).map_err(|e| e.to_string())?
            .timeout(Duration::from_secs(120))
            .version_comparator(move |current, release| offer_version(&current, &release.version, channel))
            .build().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
        if let Some(update) = update {
            if update.version != release.tag_name.trim_start_matches('v') { return Err("Update manifest version disagrees with release tag".into()); }
            if !update.download_url.as_str().starts_with(&format!("{DOWNLOADS}{}/", release.tag_name)) {
                return Err("Update payload URL must belong to the selected Boite release".into());
            }
            let version = update.version.clone();
            *state.pending.lock().unwrap() = Some(Pending { update, path: None, digest: None });
            Ok(state.change(&app, |s| { s.phase = "available".into(); s.version = Some(version);
                s.notes = release.body; s.published_at = release.published_at; }))
        } else { Ok(state.change(&app, |s| s.phase = "current".into())) }
    }.await;
    Ok(result.unwrap_or_else(|e| state.fail(&app, e)))
}

#[tauri::command]
pub async fn app_update_download(webview: Webview, app: AppHandle, state: State<'_, AppUpdater>) -> Result<Snapshot, String> {
    crate::browser::only_main(&webview)?;
    let _operation = state.begin()?;
    if state.snapshot.lock().unwrap().phase != "available" { return Err("Check for an available update before downloading".into()); }
    let update = state.pending.lock().unwrap().as_ref().ok_or("No update to download")?.update.clone();
    state.change(&app, |s| { s.phase = "downloading".into(); s.received = 0; s.total = None; });
    let mut received = 0;
    let mut emitted = Instant::now();
    let result = update.download(|length, total| {
        received += length as u64;
        // At most ten UI events per second, regardless of network chunk size.
        if emitted.elapsed() >= Duration::from_millis(100) {
            state.change(&app, |s| { s.received = received; s.total = total; });
            emitted = Instant::now();
        }
    }, || {}).await;
    match result {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(&state.cache, &bytes) { return Ok(state.fail(&app, format!("Cannot cache update: {e}"))); }
            let size = bytes.len() as u64;
            let digest: [u8; 32] = Sha256::digest(&bytes).into();
            drop(bytes);
            if let Some(pending) = state.pending.lock().unwrap().as_mut() { pending.path = Some(state.cache.clone()); pending.digest = Some(digest); }
            Ok(state.change(&app, |s| { s.phase = "ready".into(); s.received = size; s.total = Some(size); }))
        }
        Err(e) => Ok(state.fail(&app, e.to_string())),
    }
}

#[tauri::command]
pub async fn app_update_install(webview: Webview, app: AppHandle, state: State<'_, AppUpdater>) -> Result<(), String> {
    crate::browser::only_main(&webview)?;
    let _operation = state.begin()?;
    if state.snapshot.lock().unwrap().phase != "ready" { return Err("Download and verify an update before installing".into()); }
    let pending = state.pending.lock().unwrap().take().ok_or("No downloaded update")?;
    let bytes = match std::fs::read(pending.path.as_ref().ok_or("Missing update payload")?) {
        Ok(bytes) => bytes,
        Err(e) => { let error = format!("Cannot read downloaded update: {e}"); state.fail(&app, error.clone()); return Err(error); }
    };
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    if pending.digest != Some(digest) {
        let error = "Downloaded update changed after signature verification".to_string();
        state.fail(&app, error.clone()); return Err(error);
    }
    state.change(&app, |s| s.phase = "installing".into());
    // The in-memory digest ties these exact bytes to the verified download.
    // On Windows Tauri exits only after the installer launches. Windows then
    // closes the shell's KILL_ON_JOB_CLOSE handle and stops its owned core.
    // An installer launch failure leaves the core and its agents running.
    let result = tauri::async_runtime::spawn_blocking(move || pending.update.install(bytes)).await;
    match result {
        Ok(Ok(())) => { app.restart(); }
        outcome => {
            let error = match outcome { Ok(Err(e)) => e.to_string(), Err(e) => e.to_string(), _ => unreachable!() };
            state.fail(&app, error.clone());
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release(tag: &str, draft: bool, signed: bool) -> Release {
        Release { tag_name: tag.into(), draft, published_at: None, body: None,
            assets: if signed { vec![Asset { name: "latest.json".into(), browser_download_url: format!("{DOWNLOADS}{tag}/latest.json") }] } else { vec![] } }
    }
    #[test]
    fn stable_includes_beta_but_never_nightly_drafts_or_unsigned_builds() {
        let releases = vec![release("v2.0.0-nightly.20260922.1", false, true), release("v2.0.0", true, true),
            release("v1.0.0", false, true), release("v2.0.0-beta.2", false, true), release("v3.0.0", false, false)];
        assert_eq!(candidate(&releases, Track::Stable).unwrap().tag_name, "v2.0.0-beta.2");
        assert_eq!(candidate(&releases, Track::Nightly).unwrap().tag_name, "v2.0.0-nightly.20260922.1");
    }
    #[test]
    fn release_manifest_must_be_attached_to_the_selected_release() {
        let mut r = release("v2.0.0", false, true);
        assert!(release_asset_url(&r).is_ok());
        r.assets[0].browser_download_url = "https://example.com/latest.json".into();
        assert!(release_asset_url(&r).is_err());
    }
    #[test]
    fn operation_guard_refuses_overlap_and_releases_on_drop() {
        let dir = std::env::temp_dir().join(format!("boite-update-test-{}", std::process::id()));
        let state = AppUpdater::new("2.0.0-beta.1".into(), dir, true);
        let guard = state.begin().unwrap();
        assert!(state.begin().is_err());
        drop(guard);
        assert!(state.begin().is_ok());
    }

    #[test]
    fn only_an_explicit_channel_switch_allows_a_downgrade() {
        let nightly = "2.0.0-nightly.20260922.1".parse().unwrap();
        let stable = "2.0.0-beta.1".parse().unwrap();
        assert!(offer_version(&nightly, &stable, Track::Stable));
        assert!(offer_version(&stable, &nightly, Track::Nightly));
        assert!(!offer_version(&nightly, &stable, Track::Nightly));
        assert!(!offer_version(&"2.0.0".parse().unwrap(), &stable, Track::Stable));
        assert!(!offer_version(&stable, &stable, Track::Stable));
    }

    // Exercise the actual Tauri manifest/download/signature path against a tiny
    // local HTTP server. No installer is ever executed and no window is opened.
    fn download_fixture(tamper: bool) -> Result<Vec<u8>, String> {
        use std::{io::{Read, Write}, net::TcpListener};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let signature = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRVlR0czA1Z2Fzc2FIOTVpL09KOVFGQm9pRVJKL0g3cUx6MEdkcTg0U2FiSFR6QU14VFFLUzJEUmdCako0MDBZVmxUeVU2N3FnZWZWTzU1dHZZRjRTQVI3TW03N2YybEFJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwMDM0OTc5CWZpbGU6c2lnbmVkLXBheWxvYWQudHh0CkNWZXZIeUthZXRjLzE1L0RjV0ZqdlBhRUtCR0p4alV6OTNBZFAvUlREekVlWXpnYkVWT0dUWCtSRVpNZm04S0NnemptYU5ab2Nla0w1Mnh3Yzh4aEFRPT0K";
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let manifest = serde_json::json!({ "version": "2.0.0", "platforms": { "windows-x86_64": {
            "url": format!("{base}/payload"), "signature": signature,
        } } }).to_string();
        let server = std::thread::spawn(move || {
            for payload in [manifest.as_bytes(), if tamper { b"changed payload" } else { b"boite updater fixture\n" }] {
                let deadline = Instant::now() + Duration::from_secs(10);
                let (mut stream, _) = loop {
                    match listener.accept() {
                        Ok(connection) => break connection,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
                        Err(e) => panic!("Updater fixture request was not received: {e}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = [0; 4096]; stream.read(&mut request).unwrap();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n", payload.len()).unwrap();
                stream.write_all(payload).unwrap();
            }
        });
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert("updater".into(), serde_json::json!({
            "pubkey": config["plugins"]["updater"]["pubkey"], "dangerousInsecureTransportProtocol": true,
        }));
        let app = tauri::test::mock_builder().plugin(tauri_plugin_updater::Builder::new().build()).build(context).unwrap();
        let result = tauri::async_runtime::block_on(async {
            let update = app.updater_builder().target("windows-x86_64").endpoints(vec![format!("{base}/latest.json").parse().unwrap()]).unwrap()
                .timeout(Duration::from_secs(5)).build().unwrap().check().await.map_err(|e| e.to_string())?.unwrap();
            assert_eq!(update.version, "2.0.0");
            update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())
        });
        server.join().unwrap();
        result
    }

    #[test]
    fn native_updater_downloads_and_verifies_the_signed_payload() {
        assert_eq!(download_fixture(false).unwrap(), b"boite updater fixture\n");
    }
    #[test]
    fn native_updater_refuses_bytes_that_do_not_match_the_signature() {
        let error = download_fixture(true).unwrap_err();
        assert!(error.to_lowercase().contains("signature"), "{error}");
    }
}
