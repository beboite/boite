use std::collections::HashSet;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;

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
        entries.sort_by(|a, b| b.0.cmp(&a.0));
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
