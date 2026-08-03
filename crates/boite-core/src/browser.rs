//! What a browser pane is allowed to point at.
//!
//! This lived in the desktop agent endpoint, where the server could not reach
//! it, so the server shipped without the `pane_open` route the MCP advertises
//! and every call 404'd. The rule is a security boundary, and a boundary
//! written twice is a boundary that holds in one place: it lives here now, and
//! both endpoints call it.
//!
//! The frontend still carries its own copy (`features/browser/url.ts`), on
//! purpose: the same request also arrives from a remote boite and never passes
//! through either endpoint. That copy and this one are tested against the same
//! cases.

use url::Url;

/// Hosts that mean "this machine", spelled exactly as a URL serializes them.
///
/// The list is short and literal on purpose: it is mirrored one for one by the
/// `frame-src` list in `tauri.conf.json`, and a host this accepts that the CSP
/// does not is a pane that opens blank. `127.0.0.2` is loopback to the network
/// stack and is deliberately not here — nobody runs a dev server on it, and a
/// rule the CSP cannot express is a rule that does not hold.
pub const LOCAL_HOSTS: [&str; 4] = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"];

/// The ports the app itself is served from in a dev build. See `classify`.
const APP_PORTS: [u16; 2] = [1420, 1430];

/// An address a browser pane may point at, and whether it leaves this machine.
pub struct BrowserUrl {
    /// Re-serialized by the parser, so what the app frames is what was checked.
    pub url: String,
    /// Off this machine, so the app asks the user before framing it.
    pub external: bool,
}

/// Decides what a browser pane is allowed to point at.
///
/// The address is not a link an agent printed, it is a document the app is
/// about to host inside its own window, and a `starts_with("http://")` says
/// nothing about that: `http://evil.com@localhost` passes it, so does
/// `http://[::]`, and so does the app's own origin. Four rules, all of them on
/// a parsed URL:
///
/// - **Scheme.** http or https, so `file://` and custom schemes cannot reach
///   further than "show me a page" ever needs to.
/// - **No credentials.** A userinfo segment exists here only to make the host
///   read as something it is not.
/// - **Never the app's own origin.** Tauri serves the window from
///   `*.localhost`, and the dev build from a port on loopback. A page framed
///   there is same-origin with the webview, which means `window.parent` and
///   the IPC behind it.
/// - **Cleartext stays on this machine.** A local dev server is the case this
///   exists for; plain http to anywhere else is a document the network writes,
///   and the shipped CSP frames no such thing either.
///
/// Anything that survives all four and is not on this machine is legal but not
/// silent: it comes back marked `external`, and the app puts the user in front
/// of it before the frame is created.
pub fn classify(raw: &str) -> Result<BrowserUrl, String> {
    let parsed = Url::parse(raw).map_err(|_| "that is not a url".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("url must start with http:// or https://".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("url must not carry a username or a password".to_string());
    }
    let Some(host) = parsed.host_str().map(|h| h.to_ascii_lowercase()) else {
        return Err("url must name a host".to_string());
    };
    if host.ends_with(".localhost") {
        return Err("that is Boite's own origin, not a page".to_string());
    }
    let on_this_machine = LOCAL_HOSTS.contains(&host.as_str());
    if on_this_machine && parsed.port().is_some_and(|p| APP_PORTS.contains(&p)) {
        return Err("that is Boite's own origin, not a page".to_string());
    }
    if parsed.scheme() == "http" && !on_this_machine {
        return Err(format!(
            "http reaches {} only; use https off this machine",
            LOCAL_HOSTS.join(", ")
        ));
    }
    Ok(BrowserUrl {
        url: parsed.to_string(),
        external: !on_this_machine,
    })
}

/// The pane kinds an agent may ask for. `browser` is the only one that carries
/// an address, and the only one this module has anything to say about.
pub const PANE_KINDS: [&str; 6] = ["dashboard", "git", "explorer", "todo", "editor", "browser"];

/// Which edge of the caller's pane the new one takes, defaulting to the right.
pub fn side_or_right(side: Option<&str>) -> &'static str {
    match side.map(str::trim) {
        Some("left") => "left",
        Some("top") => "top",
        Some("bottom") => "bottom",
        _ => "right",
    }
}

/// The security boundary of the browser pane, so it is tested as one.
///
/// Everything here is a case that the old `starts_with("http://")` check let
/// through: a host that is not the host it reads as, the app's own origin, and
/// a remote page opening silently in the user's window.
#[cfg(test)]
mod tests {
    use super::{classify, side_or_right};

    fn refused(raw: &str) -> String {
        classify(raw)
            .err()
            .unwrap_or_else(|| panic!("{raw} was allowed"))
    }

    fn allowed(raw: &str) -> (String, bool) {
        let target = classify(raw).unwrap_or_else(|e| panic!("{raw} was refused: {e}"));
        (target.url, target.external)
    }

    #[test]
    fn a_dev_server_on_this_machine_opens_without_asking() {
        for raw in [
            "http://localhost:5173/",
            "http://127.0.0.1:3000/x?y=1",
            "http://[::1]:8080/",
            "http://0.0.0.0:4000/",
            "https://localhost:5173/",
        ] {
            let (_, external) = allowed(raw);
            assert!(!external, "{raw}");
        }
    }

    #[test]
    fn anywhere_else_is_legal_but_never_silent() {
        let (url, external) = allowed("https://github.com/beboite/boite/pull/1");
        assert!(external);
        assert_eq!(url, "https://github.com/beboite/boite/pull/1");
    }

    /// The one the prefix check could never see: the host a human reads is the
    /// userinfo, and the host the request goes to is whatever follows the `@`.
    #[test]
    fn credentials_in_the_authority_are_refused() {
        for raw in [
            "http://evil.com@localhost/",
            "http://evil.com@127.0.0.1:1234/",
            "https://user:pass@example.com/",
        ] {
            assert!(refused(raw).contains("username"), "{raw}");
        }
    }

    /// `tauri.localhost` is the window itself on Windows, and 1420 is the dev
    /// server. A page framed at either reaches `window.parent` and the IPC.
    #[test]
    fn the_apps_own_origin_is_refused_outright() {
        for raw in [
            "http://tauri.localhost/index.html",
            "http://ipc.localhost/",
            "http://asset.localhost/x",
            "https://tauri.localhost/",
            "http://localhost:1420/",
            "http://127.0.0.1:1420/",
            "http://localhost:1430/",
        ] {
            assert!(refused(raw).contains("own origin"), "{raw}");
        }
    }

    /// Cleartext off this machine is refused rather than confirmed: the shipped
    /// `frame-src` does not carry plain `http:` either, so allowing it here
    /// would only produce a pane that asks the user a question and then stays
    /// blank whatever they answer.
    #[test]
    fn cleartext_stops_at_this_machine() {
        assert!(refused("http://example.com/").contains("https"));
        assert!(refused("http://[::]/").contains("https"));
        assert!(refused("http://127.0.0.2:3000/").contains("https"));
    }

    #[test]
    fn only_http_and_https_are_schemes() {
        for raw in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>x</script>",
            "tauri://localhost/",
            "not a url at all",
            "localhost:3000",
        ] {
            let _ = refused(raw);
        }
    }

    /// What the app frames is what was checked, not the string the agent sent.
    #[test]
    fn the_answer_is_the_parsed_form() {
        let (url, _) = allowed("HTTP://LocalHost:3000");
        assert_eq!(url, "http://localhost:3000/");
    }

    #[test]
    fn an_unknown_side_falls_back_to_the_right() {
        assert_eq!(side_or_right(Some(" left ")), "left");
        assert_eq!(side_or_right(Some("bottom")), "bottom");
        assert_eq!(side_or_right(Some("sideways")), "right");
        assert_eq!(side_or_right(None), "right");
    }
}
