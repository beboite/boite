//! A file an agent attached to its answer, saved where the user keeps his
//! downloads. WebView2 gives an `<a download>` no feedback in a frameless
//! window, so the UI hands the bytes here and gets back a path it can show.
//!
//! Opening runs the system's default application, so only inert documents and
//! media are opened; anything else is shown selected in its folder instead. An
//! agent, local or remote, can therefore not run a program through a click.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request};
use tauri::{Manager, Webview};

/// `ATTACHMENT_MAX_BYTES` in `packages/contracts/src/attachment-limits.ts`.
const MAX_BYTES: usize = 5 * 1024 * 1024;
const FALLBACK_NAME: &str = "attachment";
const MAX_NAME_CHARS: usize = 150;

/// Extensions whose default application only displays or plays the file.
const OPENABLE: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tif", "tiff", "heic", "ico",
    "pdf", "txt", "md", "log", "csv", "tsv", "json",
    "mp3", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus",
    "mp4", "m4v", "webm", "mov", "mkv", "avi",
    "docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf", "zip",
];

const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// A file name every desktop system accepts, with no directory in it.
pub(crate) fn safe_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']).trim_start_matches('.');
    if trimmed.is_empty() {
        return FALLBACK_NAME.into();
    }
    let (stem, extension) = split(trimmed);
    let stem: String = stem.chars().take(MAX_NAME_CHARS).collect();
    let stem = if RESERVED.contains(&stem.to_ascii_lowercase().as_str()) { format!("_{stem}") } else { stem };
    match extension {
        Some(extension) => format!("{stem}.{}", extension.chars().take(16).collect::<String>()),
        None => stem,
    }
}

fn split(name: &str) -> (&str, Option<&str>) {
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && !extension.is_empty() => (stem, Some(extension)),
        _ => (name, None),
    }
}

pub(crate) fn openable(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| OPENABLE.contains(&extension.to_ascii_lowercase().as_str()))
}

/// Writes `bytes` in `directory` under `name`, or `name (2)` and so on when
/// another file holds it. A file there with the same name and the same bytes
/// is the one a previous click saved, and is reused rather than copied again.
pub(crate) fn save_into(directory: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let name = safe_name(name);
    let (stem, extension) = split(&name);
    fs::create_dir_all(directory).map_err(|error| format!("directory {}: {error}", directory.display()))?;
    for attempt in 1..=999 {
        let candidate = directory.join(match (attempt, extension) {
            (1, _) => name.clone(),
            (n, Some(extension)) => format!("{stem} ({n}).{extension}"),
            (n, None) => format!("{stem} ({n})"),
        });
        match OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(mut file) => {
                let written = file.write_all(bytes).and_then(|()| file.sync_all());
                if let Err(error) = written {
                    drop(file);
                    let _ = fs::remove_file(&candidate);
                    return Err(format!("path {}: {error}", candidate.display()));
                }
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let same = fs::metadata(&candidate).is_ok_and(|meta| meta.is_file() && meta.len() == bytes.len() as u64)
                    && fs::read(&candidate).is_ok_and(|existing| existing == bytes);
                if same {
                    return Ok(candidate);
                }
            }
            Err(error) => return Err(format!("path {}: {error}", candidate.display())),
        }
    }
    Err(format!("directory {}: no free name for {name}", directory.display()))
}

#[derive(serde::Serialize)]
pub struct Saved {
    path: String,
    /// True when the file was opened, false when it was only shown in its folder or not asked to open.
    opened: bool,
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Option<&'a str> {
    request.headers().get(name).and_then(|value| value.to_str().ok())
}

/// Body: the raw bytes. Headers: `x-boite-name`, percent-encoded, and
/// `x-boite-open`, `1` to open the saved file (or show it when its type is not
/// inert), anything else to only save it.
#[tauri::command]
pub async fn save_attachment(webview: Webview, request: Request<'_>) -> Result<Saved, String> {
    crate::browser::only_main(&webview)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("body: expected the attachment's raw bytes".into());
    };
    if bytes.len() > MAX_BYTES {
        return Err(format!("body: expected at most {MAX_BYTES} bytes, got {}", bytes.len()));
    }
    let name = header(&request, "x-boite-name").ok_or("x-boite-name: expected the file name")?;
    let name = decode(name).ok_or("x-boite-name: expected a percent-encoded UTF-8 name")?;
    let open = header(&request, "x-boite-open") == Some("1");
    let directory = webview
        .app_handle()
        .path()
        .download_dir()
        .map_err(|error| format!("downloads folder: {error}"))?;
    let path = save_into(&directory, &name, bytes)?;
    let mut opened = false;
    if open {
        if openable(&path) {
            crate::platform::open_file(&path)?;
            opened = true;
        } else {
            tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|error| format!("path {}: {error}", path.display()))?;
        }
    }
    Ok(Saved { path: path.display().to_string(), opened })
}

/// `encodeURIComponent` undone.
fn decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = std::str::from_utf8(bytes.get(at + 1..at + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_lose_directories_reserved_words_and_forbidden_characters() {
        assert_eq!(safe_name("photo.png"), "photo.png");
        assert_eq!(safe_name("../../evil/run.exe"), "run.exe");
        assert_eq!(safe_name("C:\\Windows\\a:b?.txt"), "a_b_.txt");
        assert_eq!(safe_name("CON.txt"), "_CON.txt");
        assert_eq!(safe_name("..."), FALLBACK_NAME);
        assert_eq!(safe_name(".bashrc"), "bashrc");
        assert_eq!(safe_name("report.pdf. "), "report.pdf");
        assert_eq!(safe_name(""), FALLBACK_NAME);
    }

    #[test]
    fn only_inert_types_open() {
        assert!(openable(Path::new("a/photo.JPG")));
        assert!(openable(Path::new("handoff.pdf")));
        for name in ["setup.exe", "run.bat", "x.ps1", "page.html", "image.svg", "link.lnk", "noextension"] {
            assert!(!openable(Path::new(name)), "{name} must not open");
        }
    }

    #[test]
    fn saving_twice_reuses_the_same_bytes_and_numbers_different_ones() {
        let root = std::env::temp_dir().join(format!("boite-attachments-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let first = save_into(&root, "shot.png", b"one").unwrap();
        assert_eq!(first, root.join("shot.png"));
        assert_eq!(save_into(&root, "shot.png", b"one").unwrap(), first);
        assert_eq!(save_into(&root, "shot.png", b"two").unwrap(), root.join("shot (2).png"));
        assert_eq!(save_into(&root, "shot.png", b"two").unwrap(), root.join("shot (2).png"));
        assert_eq!(save_into(&root, "README", b"x").unwrap(), root.join("README"));
        assert_eq!(save_into(&root, "README", b"y").unwrap(), root.join("README (2)"));
        assert_eq!(fs::read(root.join("shot (2).png")).unwrap(), b"two");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn percent_decoding_matches_encode_uri_component() {
        assert_eq!(decode("capture%20d%E2%80%99%C3%A9cran.png").as_deref(), Some("capture d\u{2019}\u{e9}cran.png"));
        assert_eq!(decode("bad%zz"), None);
        assert_eq!(decode("cut%E2"), None);
    }
}
