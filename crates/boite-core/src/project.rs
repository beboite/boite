use std::collections::HashSet;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;

/// Said to whoever asked for a project folder somewhere it cannot go.
///
/// It lived in the desktop commands with a comment saying it was shared so
/// that one refusal would not read as two rules, and then the server retyped
/// it: "under your home folder or beside a project you already have" on one
/// side, "under the home folder or beside a project that already exists" on
/// the other. Same refusal, two voices, depending on whether the agent ran
/// locally or on a deployed boite. It lives here now, where neither side can
/// have its own.
pub const WRONG_PLACE_FOR_A_PROJECT: &str =
    "a new project has to go under your home folder or beside a project you already have";

#[derive(Serialize)]
pub struct ProjectInspection {
    pub name: String,
    pub icon: Option<String>,
    pub tech: Option<String>,
}

pub fn inspect_project_blocking(path: String) -> Result<ProjectInspection, String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err("not a directory".into());
    }

    let name = git_remote_name(p)
        .or_else(|| basename(p))
        .unwrap_or_else(|| "project".to_string());
    let icon = find_icon(p);
    let tech = detect_tech(p);
    Ok(ProjectInspection { name, icon, tech })
}

/// What is already sitting where a new project wants to go.
#[derive(Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum FolderState {
    /// Nothing there. The ordinary case: the folder gets made.
    Missing,
    /// There, and holding nothing that matters. Safe to take over.
    Empty,
    /// There, with files in it. Somebody's work — never taken without saying so.
    Occupied,
}

/// Whether a project can be started here without stepping on anything.
///
/// A folder holding only the leftovers of tooling — `.git`, `.DS_Store`,
/// `Thumbs.db` — reads as empty. They are not work, and treating them as work
/// would refuse the most ordinary case there is: `git init` was run first and
/// the project set up second.
pub fn folder_state_blocking(path: &str) -> FolderState {
    let p = Path::new(path);
    if !p.exists() {
        return FolderState::Missing;
    }
    if !p.is_dir() {
        return FolderState::Occupied;
    }
    let Ok(entries) = std::fs::read_dir(p) else {
        return FolderState::Occupied;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !matches!(name.as_str(), ".git" | ".DS_Store" | "Thumbs.db" | "desktop.ini") {
            return FolderState::Occupied;
        }
    }
    FolderState::Empty
}

/// Whether a new project folder may be created at this path.
///
/// The check exists because an agent can ask for one through the MCP endpoint,
/// and `create_dir_all` with an arbitrary path is a wide capability to hand a
/// model. Two places are allowed and no others: under the user's home, and
/// under a folder that already holds one of their projects. That covers where
/// projects actually live — a `Dev` folder on another drive is reached through
/// its siblings — while a path pointing at a system directory is refused
/// without needing a list of the ones that matter.
///
/// `roots` is the parent folder of every project the workspace knows, plus the
/// home directory. Comparison is textual and case-insensitive, on separators
/// normalized to `/`: these are paths the app itself stored, not links to
/// resolve, and a symlink that escapes them is a machine the user set up that
/// way. A root that is only the top of a volume is dropped instead of matching
/// everything on it, which `names_a_folder` explains.
pub fn may_create_project_at(path: &str, roots: &[String]) -> bool {
    let Some(target) = comparable_target(path) else {
        return false;
    };
    roots.iter().any(|root| {
        let root = normalize_folder(root);
        // Equal is refused on purpose: a project rooted at the home directory
        // itself, or on top of an existing project's parent, is never what was
        // meant.
        names_a_folder(&root) && target.len() > root.len() && target.starts_with(&format!("{root}/"))
    })
}

/// Whether a new project folder may be created directly inside this one.
///
/// The same rule read from the other side, for a caller that said where the
/// project goes without saying what the folder is called. Naming it is the
/// front end's job, which slugifies the project name, and the endpoint has no
/// need to guess: whatever comes out is one segment under this folder, so a
/// parent inside the boundary can only produce paths inside it and a parent
/// outside can only produce paths outside.
///
/// Equal to a root is allowed here where `may_create_project_at` refuses it,
/// and that is the point: beside the projects already there is exactly where a
/// new one goes.
pub fn may_create_project_in(parent: &str, roots: &[String]) -> bool {
    let Some(target) = comparable_target(parent) else {
        return false;
    };
    roots.iter().any(|root| {
        let root = normalize_folder(root);
        names_a_folder(&root) && (target == root || target.starts_with(&format!("{root}/")))
    })
}

/// The path both rules above test, or nothing when it cannot be tested.
fn comparable_target(path: &str) -> Option<String> {
    // `..` never survives a prefix test honestly: "c:/users/me/../../windows"
    // starts with the home and lands nowhere near it.
    if path.split(['/', '\\']).any(|seg| seg == "..") {
        return None;
    }
    let target = normalize_folder(path);
    (!target.is_empty()).then_some(target)
}

/// Whether a normalized root names a folder rather than a whole volume.
///
/// `c:` and `//server` are prefixes, not places: everything on the drive or on
/// the machine starts with them, so a root that stops there hands out all of it.
/// They arrive for real: the roots are the *parents* of the registered project
/// folders, and the parent of a project sitting at `C:\proj` is the drive root.
fn names_a_folder(root: &str) -> bool {
    let parts: Vec<&str> = root.split('/').filter(|s| !s.is_empty()).collect();
    // One leading component that is a prefix rather than a folder: the server
    // of a UNC path, or a drive letter. Something has to sit past it.
    let prefix = usize::from(root.starts_with("//") || parts.first().is_some_and(|p| is_drive(p)));
    parts.len() > prefix
}

/// A drive letter, in the shape `normalize_folder` leaves it: `c:`.
fn is_drive(part: &str) -> bool {
    part.len() == 2 && part.ends_with(':') && part.starts_with(|c: char| c.is_ascii_alphabetic())
}

/// Whether two paths name the same folder.
///
/// Case stops mattering on Windows only, where the filesystem itself ignores it
/// and the two spellings really are one folder. Everywhere else `Data` and
/// `data` are two folders, and folding them together would let a project that
/// is not the one being named answer for it, which at the create endpoint is
/// how a path skips the checks that would have refused it.
pub fn same_folder(a: &str, b: &str) -> bool {
    #[cfg(windows)]
    {
        let a = normalize_folder(a);
        !a.is_empty() && a == normalize_folder(b)
    }
    // Nothing to normalize away here: `\\?\` is a Windows spelling, and a
    // backslash is an ordinary character in a name on every other system. Plain
    // path equality already ignores a trailing separator.
    #[cfg(not(windows))]
    {
        let a = a.trim_end_matches('/');
        !a.is_empty() && Path::new(a) == Path::new(b.trim_end_matches('/'))
    }
}

/// One folder path, in the shape both rules above compare in.
fn normalize_folder(p: &str) -> String {
    let slashed = p.replace('\\', "/");
    // The roots come out of `ProjectRoots::new_project_parents`, which stores
    // what `std::fs::canonicalize` returned, and on Windows that is a verbatim
    // path: the root reads `//?/d:/dev/perso` while the folder being asked
    // about is the plain `d:/dev/perso/thing` the caller typed. A textual
    // prefix test never brings those two together, so the marker comes off
    // both sides here. Nothing is widened by it: the stripped path still has to
    // sit under a root to be allowed.
    let bare = match slashed.strip_prefix("//?/") {
        // `//?/UNC/server/share` is the verbatim spelling of `//server/share`.
        Some(rest) => match rest.get(..4).filter(|s| s.eq_ignore_ascii_case("unc/")) {
            Some(_) => format!("//{}", &rest[4..]),
            None => rest.to_string(),
        },
        None => slashed,
    };
    bare.trim_end_matches('/').to_lowercase()
}

fn basename(p: &Path) -> Option<String> {
    p.file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
}

fn git_remote_name(p: &Path) -> Option<String> {
    let cfg = p.join(".git").join("config");
    let content = std::fs::read_to_string(cfg).ok()?;

    let mut origin_url: Option<String> = None;
    let mut any_url: Option<String> = None;
    let mut current_remote: Option<String> = None;

    for raw in content.lines() {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("[remote \"") {
            if let Some(end) = rest.find('"') {
                current_remote = Some(rest[..end].to_string());
            } else {
                current_remote = None;
            }
            continue;
        }
        if line.starts_with('[') {
            current_remote = None;
            continue;
        }
        if current_remote.is_some() {
            if let Some(eq) = line.find('=') {
                let (key, val) = line.split_at(eq);
                if key.trim() == "url" {
                    let url = val[1..].trim().to_string();
                    if current_remote.as_deref() == Some("origin") {
                        origin_url = Some(url.clone());
                    }
                    if any_url.is_none() {
                        any_url = Some(url);
                    }
                }
            }
        }
    }

    let url = origin_url.or(any_url)?;
    repo_name_from_url(&url)
}

fn repo_name_from_url(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    let after_colon = trimmed.rsplit(':').next().unwrap_or(trimmed);
    let last = after_colon.rsplit('/').next().unwrap_or(after_colon);
    let name = last.trim_end_matches(".git");
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

// ---------------------------------------------------------------------------
// Icon discovery
// ---------------------------------------------------------------------------

const MAX_ICON_SIZE: u64 = 2 * 1024 * 1024;

/// Directories scanned (non-recursively) for logo/icon/favicon-named images.
/// Order matters: earlier dirs win ties.
const SCAN_DIRS: &[&str] = &[
    "",
    "public",
    "static",
    "assets",
    "docs",
    "images",
    "img",
    "media",
    "art",
    "web",
    "resources",
    "branding",
    ".github",
    "src",
    "src/assets",
    "src/app",
    "app",
    "static/img",
    "public/images",
    "public/img",
    "public/icons",
    "docs/assets",
    "docs/images",
    "assets/images",
    "assets/icons",
    "buildResources",
    "store",
    "fastlane/metadata/android/en-US/images",
    "web/static",
    "web/public",
    "frontend/public",
    "frontend/static",
    "client/public",
    "client/static",
    "site/static",
    "www",
];

struct Candidate {
    path: PathBuf,
    score: u32,
    size: u64,
}

fn find_icon(p: &Path) -> Option<String> {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut candidates: Vec<Candidate> = Vec::new();

    let mut push = |path: PathBuf, score: u32, candidates: &mut Vec<Candidate>| {
        let Ok(meta) = std::fs::metadata(&path) else {
            return;
        };
        if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_ICON_SIZE {
            return;
        }
        let key = path.canonicalize().unwrap_or_else(|_| path.clone());
        if !seen.insert(key) {
            return;
        }
        candidates.push(Candidate {
            path,
            score,
            size: meta.len(),
        });
    };

    // 1. Tolerant name scan over known dirs.
    for (dir_idx, dir) in SCAN_DIRS.iter().enumerate() {
        let dir_path = if dir.is_empty() {
            p.to_path_buf()
        } else {
            p.join(dir)
        };
        let Ok(entries) = std::fs::read_dir(&dir_path) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(rank) = name_rank(&path) else {
                continue;
            };
            let Some(ext_rank) = ext_rank(&path) else {
                continue;
            };
            let score = rank * 100 + ext_rank * 10 + dir_idx as u32;
            push(path, score, &mut candidates);
        }
    }

    // 2. Ecosystem-specific well-known paths (beat favicons, lose to real logos).
    let eco = [
        "src-tauri/icons/128x128.png",
        "src-tauri/icons/icon.png",
        "src-tauri/icons/32x32.png",
        "build/appicon.png",
        ".idea/icon.svg",
        ".idea/icon.png",
        "web/icons/Icon-512.png",
        "web/icons/Icon-192.png",
    ];
    for (i, rel) in eco.iter().enumerate() {
        push(p.join(rel), 250 + i as u32, &mut candidates);
    }

    // Android launcher icons: highest density first.
    for base in ["app/src/main/res", "android/app/src/main/res"] {
        for (d, density) in [
            "mipmap-xxxhdpi",
            "mipmap-xxhdpi",
            "mipmap-xhdpi",
            "mipmap-hdpi",
            "mipmap-mdpi",
        ]
        .iter()
        .enumerate()
        {
            for name in ["ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"]
            {
                push(
                    p.join(base).join(density).join(name),
                    260 + d as u32,
                    &mut candidates,
                );
            }
        }
    }

    // 3. Icons declared in manifests (html link rel=icon, webmanifest, tauri.conf).
    for (i, path) in manifest_declared_icons(p).into_iter().enumerate() {
        push(path, 300 + i as u32, &mut candidates);
    }

    candidates.sort_by(|a, b| a.score.cmp(&b.score).then(b.size.cmp(&a.size)));

    for c in candidates {
        if let Some(url) = encode_data_url(&c.path) {
            return Some(url);
        }
    }
    None
}

/// Rank an image file by stem; lower is better. None = not icon-like.
fn name_rank(path: &Path) -> Option<u32> {
    let stem = path.file_stem()?.to_str()?.to_ascii_lowercase();
    Some(match stem.as_str() {
        "logo" => 0,
        "app-icon" | "appicon" | "app_icon" | "icon" | "brand" | "logotype" => 2,
        "favicon" => 4,
        _ if stem.starts_with("logo") => 1,
        _ if stem.starts_with("icon") => 3,
        _ if stem.starts_with("favicon")
            || stem.starts_with("apple-touch-icon")
            || stem.starts_with("android-chrome") =>
        {
            5
        }
        _ if stem.contains("logo") => 6,
        _ if stem.contains("icon") => 7,
        _ => return None,
    })
}

fn ext_rank(path: &Path) -> Option<u32> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "svg" => 0,
        "png" => 1,
        "webp" => 2,
        "jpg" | "jpeg" => 3,
        "ico" => 4,
        _ => return None,
    })
}

fn encode_data_url(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let mime = match ext.as_str() {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => return None,
    };
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_ICON_SIZE {
        return None;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{}", mime, b64))
}

/// Icons referenced by index.html <link rel=icon>, web app manifests, and
/// tauri.conf.json, resolved to existing files inside the project.
fn manifest_declared_icons(p: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    for html in ["index.html", "public/index.html", "src/index.html", "web/index.html"] {
        let path = p.join(html);
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let base = path.parent().unwrap_or(p).to_path_buf();
        for href in html_icon_hrefs(&content) {
            out.extend(resolve_asset_ref(p, &base, &href));
        }
    }

    for manifest in [
        "manifest.json",
        "site.webmanifest",
        "manifest.webmanifest",
        "public/manifest.json",
        "public/site.webmanifest",
        "public/manifest.webmanifest",
        "static/manifest.json",
        "static/site.webmanifest",
        "web/manifest.json",
    ] {
        let path = p.join(manifest);
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        let base = path.parent().unwrap_or(p).to_path_buf();
        let Some(icons) = json.get("icons").and_then(|v| v.as_array()) else {
            continue;
        };
        let mut entries: Vec<(u32, String)> = icons
            .iter()
            .filter_map(|i| {
                let src = i.get("src")?.as_str()?.to_string();
                let size = i
                    .get("sizes")
                    .and_then(|s| s.as_str())
                    .and_then(|s| s.split(['x', ' ']).next())
                    .and_then(|n| n.parse::<u32>().ok())
                    .unwrap_or(0);
                Some((size, src))
            })
            .collect();
        entries.sort_by_key(|b| std::cmp::Reverse(b.0));
        for (_, src) in entries {
            out.extend(resolve_asset_ref(p, &base, &src));
        }
    }

    let tauri_conf = p.join("src-tauri/tauri.conf.json");
    if let Ok(content) = std::fs::read_to_string(&tauri_conf) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
            let icons = json
                .get("bundle")
                .and_then(|b| b.get("icon"))
                .and_then(|v| v.as_array());
            if let Some(icons) = icons {
                let base = p.join("src-tauri");
                for icon in icons.iter().filter_map(|v| v.as_str()) {
                    if icon.ends_with(".png") || icon.ends_with(".ico") {
                        out.extend(resolve_asset_ref(p, &base, icon));
                    }
                }
            }
        }
    }

    out
}

/// Extract href values from <link> tags whose rel contains "icon".
fn html_icon_hrefs(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = content.to_ascii_lowercase();
    let mut pos = 0;
    while let Some(start) = lower[pos..].find("<link") {
        let start = pos + start;
        let Some(end) = lower[start..].find('>') else {
            break;
        };
        let end = start + end;
        let tag_lower = &lower[start..end];
        if tag_lower.contains("icon") && !tag_lower.contains("mask-icon") {
            if let Some(rel) = attr_value(tag_lower, "rel") {
                if rel.contains("icon") {
                    // Read href from the original (case-preserved) tag.
                    if let Some(href) = attr_value(&content[start..end], "href") {
                        out.push(href);
                    }
                }
            }
        }
        pos = end;
    }
    out
}

fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{attr}=");
    let mut search = 0;
    loop {
        let idx = lower[search..].find(&needle)? + search;
        // Must be a standalone attribute name (not e.g. "data-href=").
        if idx > 0 {
            let prev = lower.as_bytes()[idx - 1];
            if !prev.is_ascii_whitespace() {
                search = idx + needle.len();
                continue;
            }
        }
        let rest = &tag[idx + needle.len()..];
        let mut chars = rest.chars();
        return match chars.next() {
            Some(q @ ('"' | '\'')) => {
                let rest = &rest[1..];
                rest.find(q).map(|end| rest[..end].to_string())
            }
            Some(_) => {
                let end = rest
                    .find(|c: char| c.is_ascii_whitespace() || c == '>')
                    .unwrap_or(rest.len());
                Some(rest[..end].to_string())
            }
            None => None,
        };
    }
}

/// Resolve an href/src from a manifest to candidate files that exist.
fn resolve_asset_ref(root: &Path, base: &Path, href: &str) -> Vec<PathBuf> {
    let href = href.trim();
    if href.is_empty()
        || href.starts_with("http:")
        || href.starts_with("https:")
        || href.starts_with("data:")
        || href.starts_with("//")
        || href.contains("..")
    {
        return Vec::new();
    }
    let clean = href.split(['?', '#']).next().unwrap_or(href);
    let rel = clean.trim_start_matches('/');

    let mut tries = vec![base.join(rel), root.join(rel)];
    // Dev-server absolute paths usually map to the public/static dir.
    if clean.starts_with('/') {
        tries.push(root.join("public").join(rel));
        tries.push(root.join("static").join(rel));
        tries.push(root.join("web").join(rel));
    }
    tries.into_iter().filter(|t| t.is_file()).collect()
}

// ---------------------------------------------------------------------------
// Tech detection (fallback branding when no image is found)
// ---------------------------------------------------------------------------

fn detect_tech(p: &Path) -> Option<String> {
    let has = |rel: &str| p.join(rel).exists();

    if has("ProjectSettings/ProjectVersion.txt") {
        return Some("unity".into());
    }
    if root_has_ext(p, "uproject") {
        return Some("unreal".into());
    }
    if has("project.godot") {
        return Some("godot".into());
    }
    if has("pubspec.yaml") {
        let flutter = std::fs::read_to_string(p.join("pubspec.yaml"))
            .map(|c| c.contains("flutter"))
            .unwrap_or(false);
        return Some(if flutter { "flutter" } else { "dart" }.into());
    }
    if has("src-tauri/tauri.conf.json") {
        return Some("tauri".into());
    }

    if let Some(deps) = package_json_deps(p) {
        for (needle, key) in [
            ("electron", "electron"),
            ("next", "next"),
            ("nuxt", "nuxt"),
            ("@sveltejs/kit", "svelte"),
            ("svelte", "svelte"),
            ("vue", "vue"),
            ("@angular/core", "angular"),
            ("react-native", "react"),
            ("react", "react"),
        ] {
            if deps.contains(needle) {
                return Some(key.into());
            }
        }
    }

    if has("settings.gradle")
        || has("settings.gradle.kts")
        || (has("gradlew") && (has("build.gradle") || has("build.gradle.kts")))
    {
        return Some("android".into());
    }
    if has("Package.swift") || root_has_ext(p, "xcodeproj") {
        return Some("swift".into());
    }
    if has("Cargo.toml") {
        return Some("rust".into());
    }
    if has("go.mod") {
        return Some("go".into());
    }
    if has("pyproject.toml") || has("requirements.txt") || has("setup.py") {
        return Some("python".into());
    }
    if root_has_ext(p, "sln") || root_has_ext(p, "csproj") {
        return Some("dotnet".into());
    }
    if has("pom.xml") {
        return Some("java".into());
    }
    if has("CMakeLists.txt") {
        return Some("cpp".into());
    }
    if has("package.json") {
        return Some("node".into());
    }
    None
}

fn root_has_ext(p: &Path, ext: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(p) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.path()
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case(ext))
            .unwrap_or(false)
    })
}

fn package_json_deps(p: &Path) -> Option<HashSet<String>> {
    let content = std::fs::read_to_string(p.join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let mut deps = HashSet::new();
    for section in ["dependencies", "devDependencies"] {
        if let Some(obj) = json.get(section).and_then(|v| v.as_object()) {
            deps.extend(obj.keys().cloned());
        }
    }
    Some(deps)
}

#[cfg(test)]
mod new_project_tests {
    use super::*;

    /// The rule an agent's `project_create` runs into. Roots are the home
    /// directory plus the parent folder of every project already known.
    fn roots() -> Vec<String> {
        vec!["C:/Users/me".into(), "D:/Dev/Collab".into()]
    }

    #[test]
    fn a_folder_under_a_known_root_is_allowed() {
        assert!(may_create_project_at("C:/Users/me/ideas/thing", &roots()));
        assert!(may_create_project_at("D:/Dev/Collab/newrepo", &roots()));
        // The separator and the case are the machine's business, not the rule's.
        assert!(may_create_project_at(r"d:\dev\collab\newrepo", &roots()));
    }

    /// What the roots actually look like at runtime on Windows. They are the
    /// parents of what `ProjectRoots` holds, which is `std::fs::canonicalize`
    /// output, and that is verbatim: every root but the home directory arrived
    /// here with a `\\?\` on the front and matched nothing. The roots are passed
    /// in that shape below, since that is the shape the rule is fed.
    #[test]
    fn a_verbatim_windows_root_still_matches_a_plain_path() {
        let roots = vec![
            r"\\?\C:\Users\me".to_string(),
            r"\\?\D:\Dev\Collab".to_string(),
        ];
        assert!(may_create_project_at(r"D:\Dev\Collab\newrepo", &roots));
        assert!(may_create_project_at("C:/Users/me/ideas/thing", &roots));
        // Verbatim on the asking side too, and the pair of them at once.
        assert!(may_create_project_at(r"\\?\D:\Dev\Collab\newrepo", &roots));
        // A UNC share keeps its own shape rather than losing a segment to the
        // `UNC` marker.
        assert!(may_create_project_at(
            r"\\nas\dev\newrepo",
            &[r"\\?\UNC\nas\dev".to_string()],
        ));
        // Stripping the marker is not a way in: the rest of the path still has
        // to be under a root.
        assert!(!may_create_project_at(r"\\?\C:\Windows\x", &roots));
    }

    #[test]
    fn anywhere_else_is_refused() {
        for path in [
            "C:/Windows/System32/evil",
            "D:/Dev/Other/thing",
            "/etc/cron.d/thing",
            "",
        ] {
            assert!(!may_create_project_at(path, &roots()), "{path}");
        }
    }

    /// A root that is only the top of a volume matches everything on it. The
    /// case is not theoretical: the roots are the parents of the registered
    /// project folders, so one project sitting at `C:\proj` makes the drive
    /// root a root, and the endpoint would let an agent create a folder
    /// anywhere on `C:`.
    #[test]
    fn the_top_of_a_volume_is_not_a_root() {
        // What `ProjectRoots` really hands over for a project at `C:\proj`.
        let drive = vec![r"\\?\C:\".to_string()];
        assert!(!may_create_project_at(
            "c:/windows/system32/drivers/etc/newproj",
            &drive
        ));
        assert!(!may_create_project_at("C:/anything", &drive));
        assert!(!may_create_project_in("C:/windows/system32", &drive));
        // Spelled every way it reaches here.
        for root in [r"C:\", "c:/", "c:", r"\\?\C:"] {
            assert!(
                !may_create_project_at("C:/windows/x", &[root.to_string()]),
                "{root}"
            );
        }
        // A machine with no share named is the same kind of prefix, and so is
        // the root of a POSIX filesystem.
        assert!(!may_create_project_at(
            r"\\nas\dev\newrepo",
            &[r"\\nas".to_string()]
        ));
        assert!(!may_create_project_at("/etc/thing", &["/".to_string()]));
        // The share itself is a folder, and so is a directory on the drive.
        assert!(may_create_project_at(
            r"\\nas\dev\newrepo",
            &[r"\\nas\dev".to_string()]
        ));
        assert!(may_create_project_at("C:/Users/me/thing", &roots()));
    }

    /// What the agent endpoint asks when the caller named a parent folder and
    /// left the folder name to Boite.
    #[test]
    fn a_project_may_be_created_beside_the_ones_already_there() {
        // The root itself is where the new one goes, which is the whole
        // difference with `may_create_project_at`.
        assert!(may_create_project_in("D:/Dev/Collab", &roots()));
        assert!(may_create_project_in(r"c:\users\me\", &roots()));
        // Deeper in is still inside.
        assert!(may_create_project_in("D:/Dev/Collab/team", &roots()));
        // And the refusals the endpoint exists for.
        assert!(!may_create_project_in(r"C:\Windows\System32", &roots()));
        assert!(!may_create_project_in("D:/Dev/Other", &roots()));
        assert!(!may_create_project_in("C:/Users/me/../../Windows", &roots()));
        assert!(!may_create_project_in("", &roots()));
        assert!(!may_create_project_in("C:/Users/me", &[]));
    }

    /// The endpoint reads this against the folders of projects the user
    /// already has, to tell a creation apart from a reuse before it refuses
    /// anything.
    #[cfg(windows)]
    #[test]
    fn the_same_folder_spelled_two_ways_is_one_folder() {
        assert!(same_folder(r"D:\Dev\Perso\thing", "d:/dev/perso/thing/"));
        assert!(same_folder(r"\\?\D:\Dev\Perso\thing", r"D:\Dev\Perso\thing"));
        assert!(!same_folder(r"D:\Dev\Perso\thing", r"D:\Dev\Perso\other"));
        // A folder deeper in is not the same folder, which is what keeps a
        // project inside another one from reading as a reuse.
        assert!(!same_folder(r"D:\Dev\Perso", r"D:\Dev\Perso\thing"));
        assert!(!same_folder("", ""));
    }

    /// Off Windows, two spellings that differ in case are two folders, and the
    /// answer has to say so: a project reading as already there is what stops
    /// the create endpoint from asking whether the folder is free and whether
    /// it may be written at all.
    #[cfg(not(windows))]
    #[test]
    fn a_folder_that_differs_in_case_is_another_folder() {
        assert!(same_folder("/home/me/dev/thing", "/home/me/dev/thing/"));
        // A repeated separator is the same folder to the system, so it is here.
        assert!(same_folder("/home/me/dev//thing", "/home/me/dev/thing"));
        assert!(!same_folder("/home/me/dev/Thing", "/home/me/dev/thing"));
        assert!(!same_folder("/home/me/dev/thing", "/home/me/dev/other"));
        assert!(!same_folder("/home/me/dev", "/home/me/dev/thing"));
        // A backslash is an ordinary character in a name here, not a separator.
        assert!(!same_folder(r"\home\me", "/home/me"));
        assert!(!same_folder("", ""));
    }

    /// A prefix test is the whole check, so anything that walks back out of the
    /// root has to be refused before it runs — "C:/Users/me/../../Windows/x"
    /// passes `starts_with` and points at the system directory.
    #[test]
    fn a_path_that_climbs_out_is_refused() {
        assert!(!may_create_project_at("C:/Users/me/../../Windows/x", &roots()));
        assert!(!may_create_project_at(r"D:\Dev\Collab\..\..\x", &roots()));
    }

    /// A root itself is not a place to put a project: it is where the others
    /// already are.
    #[test]
    fn a_root_itself_is_not_a_project_folder() {
        assert!(!may_create_project_at("C:/Users/me", &roots()));
        assert!(!may_create_project_at("D:/Dev/Collab/", &roots()));
    }

    #[test]
    fn a_folder_holding_only_tooling_leftovers_reads_as_empty() {
        let dir = std::env::temp_dir()
            .join(format!("boite-folder-state-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            folder_state_blocking(dir.to_str().unwrap()),
            FolderState::Missing
        );

        std::fs::create_dir_all(dir.join(".git")).unwrap();
        assert_eq!(
            folder_state_blocking(dir.to_str().unwrap()),
            FolderState::Empty
        );

        std::fs::write(dir.join("README.md"), "mine").unwrap();
        assert_eq!(
            folder_state_blocking(dir.to_str().unwrap()),
            FolderState::Occupied
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
