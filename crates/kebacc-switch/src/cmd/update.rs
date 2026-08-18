use super::Options;
use crate::lock;
use crate::term::{say, Color};
use crate::usage;
use serde_json::{json, Value};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const REPO: &str = match option_env!("KEBACC_SWITCH_RELEASES_REPO") {
    Some(repo) => repo,
    None => "beboite/boite",
};
const TAG_PREFIX: &str = "kebacc-switch-v";
const DEFAULT_INTERVAL_MS: u128 = 24 * 60 * 60 * 1000;
const MAX_BYTES: u64 = 64 * 1024 * 1024;
const DOWNLOAD_SECONDS: u64 = 120;
const RETRY_MS: u128 = 60 * 60 * 1000;

pub const MARKER: &str = ".update.json";
const STAMP: &str = "update.stamp";

pub fn run(opts: &Options) -> i32 {
    if off() {
        if !opts.quiet {
            say(
                "Updates are off: KEBACC_SWITCH_UPDATE says so.",
                Color::Yellow,
            );
        }
        return 0;
    }
    let here = version();
    let release = match latest() {
        Ok(Some(release)) => release,
        Ok(None) => {
            if !opts.quiet {
                say(&format!("kebacc-switch {here} is the latest."), Color::Dim);
            }
            return 0;
        }
        Err(problem) => {
            if !opts.quiet {
                say(&problem, Color::Yellow);
            }
            return 1;
        }
    };
    if !newer(&release.version, &here) {
        if !opts.quiet {
            say(&format!("kebacc-switch {here} is the latest."), Color::Dim);
        }
        return 0;
    }
    if opts.check {
        say(
            &format!(
                "kebacc-switch {} is out. You are on {here}.",
                release.version
            ),
            Color::Yellow,
        );
        return 10;
    }
    let Some(asset) = release.asset else {
        if !opts.quiet {
            say(
                &format!(
                    "Release {} has nothing built for {} {}.",
                    release.version,
                    std::env::consts::OS,
                    std::env::consts::ARCH
                ),
                Color::Yellow,
            );
        }
        return 1;
    };
    match install(&asset, &here, &release.version) {
        Ok(()) => {
            if !opts.quiet {
                say(
                    &format!("Updated kebacc-switch {here} to {}.", release.version),
                    Color::Green,
                );
            }
            0
        }
        Err(problem) => {
            if opts.quiet {
                retry_sooner();
            } else {
                say(&problem, Color::Red);
            }
            1
        }
    }
}

fn retry_sooner() {
    let stamp = crate::provider::state_dir().join(STAMP);
    let when = now_ms().saturating_sub(interval_ms().saturating_sub(RETRY_MS));
    let _ = std::fs::write(stamp, when.to_string());
}

pub fn maybe() {
    if off() {
        return;
    }
    let stamp = crate::provider::state_dir().join(STAMP);
    if !due(&stamp) {
        return;
    }
    let _ = std::fs::write(&stamp, now_ms().to_string());
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let mut command = Command::new(exe);
    command
        .args(["update", "-Quiet"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    super::midtask::detach(&mut command);
    let _ = command.spawn();
}

pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn off() -> bool {
    std::env::var("KEBACC_SWITCH_UPDATE")
        .is_ok_and(|flag| matches!(flag.trim().to_lowercase().as_str(), "0" | "off" | "no"))
}

fn interval_ms() -> u128 {
    std::env::var("KEBACC_SWITCH_UPDATE_INTERVAL_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u128>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_INTERVAL_MS)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn due(stamp: &Path) -> bool {
    let Some(last) = std::fs::read_to_string(stamp)
        .ok()
        .and_then(|text| text.trim().parse::<u128>().ok())
    else {
        return true;
    };
    let now = now_ms();
    last > now || now - last >= interval_ms()
}

struct Release {
    version: String,
    asset: Option<Asset>,
}

struct Asset {
    url: String,
    digest: Option<String>,
}

fn latest() -> Result<Option<Release>, String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases?per_page=30");
    let mut response = usage::agent()
        .get(&url)
        .header("User-Agent", &format!("kebacc-switch/{}", version()))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(|_| format!("Could not reach {url}."))?;
    if !response.status().is_success() {
        return Err(format!("GitHub answered {}.", response.status()));
    }
    let releases = response
        .body_mut()
        .read_json::<Value>()
        .map_err(|_| "GitHub answered something that is not a release list.".to_string())?;
    let wanted = asset_name();
    let mut best: Option<Release> = None;
    let Some(listed) = releases.as_array() else {
        return Ok(None);
    };
    for release in listed {
        if release.get("draft") == Some(&Value::Bool(true))
            || release.get("prerelease") == Some(&Value::Bool(true))
        {
            continue;
        }
        let Some(version) = release
            .get("tag_name")
            .and_then(Value::as_str)
            .and_then(|tag| tag.strip_prefix(TAG_PREFIX))
        else {
            continue;
        };
        if best
            .as_ref()
            .is_some_and(|found| !newer(version, &found.version))
        {
            continue;
        }
        best = Some(Release {
            version: version.to_string(),
            asset: asset_of(release, &wanted),
        });
    }
    Ok(best)
}

fn asset_of(release: &Value, wanted: &str) -> Option<Asset> {
    let found = release
        .get("assets")
        .and_then(Value::as_array)?
        .iter()
        .find(|asset| asset.get("name").and_then(Value::as_str) == Some(wanted))?;
    Some(Asset {
        url: found
            .get("browser_download_url")
            .and_then(Value::as_str)?
            .to_string(),
        digest: found
            .get("digest")
            .and_then(Value::as_str)
            .and_then(|raw| raw.strip_prefix("sha256:"))
            .map(str::to_lowercase),
    })
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn asset_name() -> String {
    let triple = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        ("windows", "aarch64") => "aarch64-pc-windows-msvc",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        _ => "unsupported",
    };
    format!("kebacc-switch-{triple}{}", std::env::consts::EXE_SUFFIX)
}

fn newer(candidate: &str, current: &str) -> bool {
    fields(candidate) > fields(current)
}

fn fields(version: &str) -> (u64, u64, u64) {
    let mut parts = version
        .trim()
        .split(['.', '-', '+'])
        .map(|part| part.parse::<u64>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

fn install(asset: &Asset, from: &str, to: &str) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|_| "Cannot find my own path.".to_string())?;
    let dir = exe
        .parent()
        .ok_or_else(|| "Cannot find my own directory.".to_string())?
        .to_path_buf();

    lock::locked(lock::UPDATE, || {
        let bytes = download(&asset.url)?;
        if let Some(wanted) = &asset.digest {
            let got = sha256(&bytes);
            if &got != wanted {
                return Err(format!(
                    "The download does not match what the release says it is: {got} instead of {wanted}."
                ));
            }
        }

        let fresh = dir.join(format!("kebacc-switch.{}.new", std::process::id()));
        std::fs::write(&fresh, &bytes).map_err(|_| format!("Cannot write {}.", fresh.display()))?;
        runnable(&fresh);
        if let Err(problem) = swap(&exe, &fresh) {
            let _ = std::fs::remove_file(&fresh);
            return Err(problem);
        }

        let _ = crate::jsonio::write_text(&dir.join(".version"), to);
        let _ = crate::jsonio::write(
            &dir.join(MARKER),
            &json!({ "from": from, "to": to, "at": now_ms() as u64 }),
        );
        Ok(())
    })?
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    let mut response = usage::agent_with_timeout(DOWNLOAD_SECONDS)
        .get(url)
        .header("User-Agent", &format!("kebacc-switch/{}", version()))
        .call()
        .map_err(|_| format!("Could not download {url}."))?;
    if !response.status().is_success() {
        return Err(format!("{url} answered {}.", response.status()));
    }
    let bytes = response
        .body_mut()
        .with_config()
        .limit(MAX_BYTES)
        .read_to_vec()
        .map_err(|_| "The download did not finish.".to_string())?;
    if bytes.len() < 1024 {
        return Err("The download is too small to be the switcher.".into());
    }
    Ok(bytes)
}

fn swap(exe: &Path, fresh: &Path) -> Result<(), String> {
    let stale = exe.with_extension("old");
    let _ = std::fs::remove_file(&stale);
    if exe.exists() {
        std::fs::rename(exe, &stale)
            .map_err(|_| format!("Cannot move {} out of the way.", exe.display()))?;
    }
    if let Err(problem) = std::fs::rename(fresh, exe) {
        let _ = std::fs::rename(&stale, exe);
        return Err(format!("Cannot put the new binary in place: {problem}"));
    }
    let _ = std::fs::remove_file(&stale);
    Ok(())
}

#[cfg(unix)]
fn runnable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
}

#[cfg(not(unix))]
fn runnable(_path: &Path) {}

pub fn last(dir: &Path) -> Option<(String, String, u128)> {
    let marker = crate::jsonio::read(&dir.join(MARKER))?;
    let at = marker.get("at").and_then(Value::as_u64)? as u128;
    let now = now_ms();
    let age = now.checked_sub(at)?;
    if age > interval_ms() {
        return None;
    }
    Some((
        crate::jsonio::str_of(&marker, "from")?,
        crate::jsonio::str_of(&marker, "to")?,
        age,
    ))
}

pub fn sweep() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let _ = std::fs::remove_file(exe.with_extension("old"));
    let Some(dir) = exe.parent() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("kebacc-switch.") && name.ends_with(".new") && !recent(&entry) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn recent(entry: &std::fs::DirEntry) -> bool {
    entry
        .metadata()
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|when| when.elapsed().ok())
        .is_some_and(|age| age.as_millis() < RETRY_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_by_number_not_by_text() {
        assert!(newer("5.10.0", "5.9.0"));
        assert!(!newer("5.0.0", "5.0.0"));
        assert!(!newer("4.9.9", "5.0.0"));
        assert!(newer("5.0.1", "5.0.0"));
    }

    #[test]
    fn the_digest_is_the_one_github_publishes() {
        assert_eq!(
            sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn a_release_without_a_digest_still_yields_an_asset() {
        let release = serde_json::json!({
            "assets": [{ "name": "kebacc-switch-x", "browser_download_url": "https://example/x" }]
        });
        let asset = asset_of(&release, "kebacc-switch-x").expect("asset");
        assert_eq!(asset.url, "https://example/x");
        assert!(asset.digest.is_none());
    }

    #[test]
    fn a_digest_loses_its_prefix() {
        let release = serde_json::json!({
            "assets": [{
                "name": "kebacc-switch-x",
                "browser_download_url": "https://example/x",
                "digest": "sha256:AB12"
            }]
        });
        let asset = asset_of(&release, "kebacc-switch-x").expect("asset");
        assert_eq!(asset.digest.as_deref(), Some("ab12"));
    }

    #[test]
    fn an_unparsable_tag_never_wins() {
        assert!(!newer("nightly", "5.0.0"));
    }
}
