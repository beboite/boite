//! Who is calling, and what they are allowed to be asking about.
//!
//! The token proves the caller came from Boite. It does not say which project
//! they may see: a leaked token with no thread reaches nothing. That second
//! question is what the rest of this module answers.

use axum::http::{HeaderMap, StatusCode};
use subtle::ConstantTimeEq;

use crate::Workspace;

/// How a host turns a request into a project.
///
/// Two answers today, and only one of them is meant to survive. The desktop
/// accepts a working directory because agents were reaching it before Boite
/// stamped a thread id into every terminal it opens; the server never did.
///
/// A directory is not an identity — it is a string the caller chose, and the
/// project it lands in is whichever one happens to contain it. Phase 3 mints a
/// key per thread and deletes [`Resolution::ThreadThenCwd`] along with this
/// enum. It exists so that removal is one commit with one thing in it, rather
/// than a behaviour change smuggled into a refactor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    /// The thread id, or nothing.
    ThreadOnly,
    /// The thread id, then the working directory, then a named project.
    ThreadThenCwd,
}

/// The thread the caller says it is, as presented. Empty means it said nothing.
pub(crate) fn thread_header(headers: &HeaderMap) -> &str {
    headers
        .get("x-boite-thread")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

/// Checks the token alone. Every entry point starts here.
fn bearer_ok(workspace: &dyn Workspace, headers: &HeaderMap) -> Result<(), StatusCode> {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    // Constant time: a local process can call this in a loop, and a
    // byte-by-byte `!=` short-circuits, so the token reads out of the timing
    // rather than having to be guessed.
    let ok: bool = bearer
        .as_bytes()
        .ct_eq(workspace.token().as_bytes())
        .into();
    ok.then_some(()).ok_or(StatusCode::UNAUTHORIZED)
}

/// Token proves the caller came from us; the thread decides what it may see.
pub(crate) fn authorize(
    workspace: &dyn Workspace,
    headers: &HeaderMap,
) -> Result<String, StatusCode> {
    bearer_ok(workspace, headers)?;
    let thread_id = thread_header(headers);
    if !thread_id.is_empty() {
        return workspace
            .store()
            .project_of_thread(thread_id)
            .map_err(|_| StatusCode::NOT_FOUND);
    }
    if workspace.resolution() == Resolution::ThreadOnly {
        return Err(StatusCode::BAD_REQUEST);
    }
    // See `Resolution`: neither of these is an identity, and both go away with
    // it. Kept verbatim for now so agents reaching the desktop through a shim
    // that predates the thread id keep working.
    if let Some(cwd) = headers.get("x-boite-cwd").and_then(|v| v.to_str().ok()) {
        if let Some(id) = project_of_cwd(workspace, cwd) {
            return Ok(id);
        }
    }
    let named = headers
        .get("x-boite-project")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .ok_or(StatusCode::BAD_REQUEST)?;
    workspace
        .store()
        .load_projects()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .into_iter()
        .any(|p| p.id == named)
        .then(|| named.to_string())
        .ok_or(StatusCode::NOT_FOUND)
}

/// The thread this caller runs in, once it is known to belong to a project here.
/// Everything that acts on the terminal itself needs it.
pub(crate) fn thread_of_request(
    workspace: &dyn Workspace,
    headers: &HeaderMap,
) -> Result<String, StatusCode> {
    authorize(workspace, headers)?;
    Ok(thread_header(headers).to_string())
}

/// The repository and worktree behind this caller's thread.
///
/// CONFLICT when the thread runs in the project folder: it exists, it simply
/// has no worktree, and the agent should be told that rather than given a
/// not-found.
pub(crate) fn worktree_of_request(
    workspace: &dyn Workspace,
    headers: &HeaderMap,
) -> Result<(String, String), StatusCode> {
    // Goes through authorize first: the token still has to be right, and the
    // thread still has to belong to a project this workspace knows.
    authorize(workspace, headers)?;
    workspace
        .store()
        .worktree_of_thread(thread_header(headers))
        .ok_or(StatusCode::CONFLICT)
}

/// Which agent is speaking, when Boite launched the terminal it speaks from.
///
/// The thread carries the icon key already — it is what the sidebar and the
/// shortcut bar draw — so a claim can be shown under the badge of the agent that
/// made it rather than a generic robot. Credentials that came from a file name a
/// project and no thread, and that claim stays anonymous unless the caller sends
/// a name this app can draw.
pub(crate) fn agent_of_request(
    workspace: &dyn Workspace,
    headers: &HeaderMap,
) -> Option<String> {
    let thread_id = thread_header(headers);
    if !thread_id.is_empty() {
        if let Some(named) = workspace
            .store()
            .agent_of_thread(thread_id)
            .filter(|k| !k.is_empty())
        {
            return Some(named);
        }
    }
    headers
        .get("x-boite-agent")
        .and_then(|v| v.to_str().ok())
        .and_then(known_agent)
}

/// The header, if it names an agent Boite can draw.
///
/// Checked rather than taken: the value comes from a config file the user (or
/// anything with write access to it) can edit, it ends up stored on a row and
/// then in an `<img>` path, and an unrecognised one would at best be a badge
/// nobody knows.
pub fn known_agent(value: &str) -> Option<String> {
    const KNOWN: [&str; 8] = [
        "claude",
        "codex",
        "antigravity",
        "cursor",
        "copilot",
        "opencode",
        "grok",
        "hermes",
    ];
    let value = value.trim().to_ascii_lowercase();
    KNOWN.contains(&value.as_str()).then_some(value)
}

/// Undoes the shim's percent-encoding of the cwd header.
///
/// Lenient by design: a stray `%` that starts no valid pair is kept as itself
/// rather than dropped, since the worst case here is a path that matches no
/// project, and refusing to decode would turn that into no answer at all.
fn decode_header_path(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| match b {
                b'0'..=b'9' => Some(b - b'0'),
                b'a'..=b'f' => Some(b - b'a' + 10),
                b'A'..=b'F' => Some(b - b'A' + 10),
                _ => None,
            };
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Normalized the same way both sides of a path comparison have to be: the
/// separator agents report varies on Windows, a trailing slash is noise, and the
/// two file systems this ships on are case-insensitive.
fn normalize_path(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// The project a directory belongs to, if any.
///
/// The deepest match wins, so a project nested inside another answers for its
/// own subtree rather than losing it to the parent. A prefix only counts on a
/// separator boundary — `/a/boite` must not swallow `/a/boite-mcp`.
fn project_of_cwd(workspace: &dyn Workspace, cwd: &str) -> Option<String> {
    let target = normalize_path(&decode_header_path(cwd));
    if target.is_empty() {
        return None;
    }
    let projects = workspace.store().load_projects().ok()?;
    let mut best: Option<(String, usize)> = None;
    for project in projects {
        let root = normalize_path(&project.cwd);
        if root.is_empty() {
            continue;
        }
        let inside = target == root
            || (target.starts_with(&root) && target.as_bytes().get(root.len()) == Some(&b'/'));
        if inside && best.as_ref().is_none_or(|(_, len)| root.len() > *len) {
            best = Some((project.id, root.len()));
        }
    }
    best.map(|(id, _)| id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fake;

    /// The directory itself and anything under it belong to the project; its
    /// parent does not.
    #[test]
    fn a_cwd_resolves_to_the_project_holding_it() {
        let fake = Fake::new("cwd-basic").with_project("p", "/w/boite");
        assert_eq!(project_of_cwd(&fake, "/w/boite").as_deref(), Some("p"));
        assert_eq!(project_of_cwd(&fake, "/w/boite/src").as_deref(), Some("p"));
        assert_eq!(project_of_cwd(&fake, "/w").as_deref(), None);
        assert_eq!(project_of_cwd(&fake, "").as_deref(), None);
    }

    /// A prefix only counts on a separator boundary: `/w/boite` must not
    /// swallow `/w/boite-mcp`, which is a different repository next door.
    #[test]
    fn a_prefix_only_counts_on_a_separator() {
        let fake = Fake::new("cwd-prefix").with_project("p", "/w/boite");
        assert_eq!(project_of_cwd(&fake, "/w/boite-mcp").as_deref(), None);
    }

    /// The deepest match wins, so a project nested inside another answers for
    /// its own subtree rather than losing it to the one holding it.
    #[test]
    fn the_deepest_project_wins() {
        let fake = Fake::new("cwd-deep")
            .with_project("outer", "/w")
            .with_project("inner", "/w/apps/api");
        assert_eq!(
            project_of_cwd(&fake, "/w/apps/api/src").as_deref(),
            Some("inner")
        );
        assert_eq!(project_of_cwd(&fake, "/w/apps/web").as_deref(), Some("outer"));
    }

    /// The shim percent-encodes the header, and the separator an agent reports
    /// on Windows is not the one the row was stored with.
    #[test]
    fn encoded_accents_and_windows_paths_resolve() {
        let fake = Fake::new("cwd-encoded").with_project("q", r"C:\Users\x\boite");
        assert_eq!(
            project_of_cwd(&fake, "C%3A%5CUsers%5Cx%5Cboite").as_deref(),
            Some("q")
        );
        assert_eq!(project_of_cwd(&fake, r"c:\users\x\boite").as_deref(), Some("q"));
    }

    #[test]
    fn a_header_path_decodes_leniently() {
        assert_eq!(decode_header_path("/a%2Fb"), "/a/b");
        assert_eq!(decode_header_path("C%3A%5Cdev"), "C:\\dev");
        // A `%` that starts nothing valid is itself, not a dropped byte.
        assert_eq!(decode_header_path("100%"), "100%");
        assert_eq!(decode_header_path("50%zz"), "50%zz");
    }

    #[test]
    fn paths_compare_the_same_on_both_sides() {
        assert_eq!(normalize_path("C:\\Dev\\Boite\\"), "c:/dev/boite");
        assert_eq!(normalize_path("/a/b/"), "/a/b");
    }

    #[test]
    fn only_one_agent_name_per_row_is_drawable() {
        assert_eq!(known_agent(" Claude "), Some("claude".into()));
        assert_eq!(known_agent("CODEX"), Some("codex".into()));
        // Anything else lands in an <img> path nobody has an icon for.
        assert_eq!(known_agent("../../etc/passwd"), None);
        assert_eq!(known_agent(""), None);
    }
}
