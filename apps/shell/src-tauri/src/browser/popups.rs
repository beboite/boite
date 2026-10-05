//! A page that opens a sized window, which is how "Sign in with Google" and
//! most other sign-in buttons open theirs, gets a real one: a popup window in
//! the same profile, whose `window.opener` is the page that asked. The sign-in
//! answers through that opener and closes itself. Any other new window becomes
//! a tab in the same panel, as does a popup past the few one surface may hold.

use super::{announce, checked_url, Event, BLANK, SCHEMES};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// A popup window's label: this, a number, `:`, then the id of the surface
/// whose page opened it, or whose popup did.
const POPUP_PREFIX: &str = "boite-popup:";
static POPUP_COUNT: AtomicU64 = AtomicU64::new(0);
/// Live popups one surface may hold. WebView2 has no popup blocker and wry
/// does not say whether a click asked, so past this a sized `window.open` is
/// a tab like any other new window.
const POPUPS_PER_SURFACE: usize = 3;

fn popup_label(surface: &str) -> String {
    format!("{POPUP_PREFIX}{}:{surface}", POPUP_COUNT.fetch_add(1, Ordering::Relaxed))
}

/// The surface a popup belongs to. A surface id may itself carry `:`, so the
/// number is what is split off.
fn popup_surface(label: &str) -> Option<&str> {
    let (number, surface) = label.strip_prefix(POPUP_PREFIX)?.split_once(':')?;
    number.parse::<u64>().ok().map(|_| surface)
}

/// How many of these window labels are popups of `surface`.
fn popups_of<'a>(labels: impl IntoIterator<Item = &'a str>, surface: &str) -> usize {
    labels.into_iter().filter(|label| popup_surface(label) == Some(surface)).count()
}

/// A popup's title: where it is first, then what the page calls itself. It has
/// no address bar, so a page titled like a sign-in cannot hide its host.
fn popup_title(url: Option<&Url>, title: &str) -> String {
    let place = url.map_or(BLANK, |url| url.host_str().unwrap_or_else(|| url.as_str().split(['?', '#']).next().unwrap_or(BLANK)));
    let title = title.trim();
    if title.is_empty() || title == place { place.to_owned() } else { format!("{place} – {title}") }
}

/// Closes the popups of one surface, or all of them: they go with the tab
/// whose page opened them.
pub(super) fn close_popups<R: Runtime>(app: &AppHandle<R>, surface: Option<&str>) {
    for (label, window) in app.webview_windows() {
        let Some(owner) = popup_surface(&label) else { continue };
        if surface.is_some_and(|surface| surface != owner) { continue; }
        if let Err(error) = window.close() {
            eprintln!("[shell] the browser popup {label} could not be closed: {error}");
        }
    }
}

/// What a page that asks for a new window gets. `window.open` with a size or
/// a position is a popup, and keeps its opener; a link with
/// `target="_blank"`, or `window.open` with neither, is a tab the UI opens in
/// the same panel and profile.
pub(super) fn new_window(app: &AppHandle, surface: &str, private: bool, url: Url, features: NewWindowFeatures) -> NewWindowResponse<tauri::Wry> {
    if checked_url(surface, url.as_str()).is_err() {
        return NewWindowResponse::Deny;
    }
    let sized = features.size().is_some() || features.position().is_some();
    if sized && popups_of(app.webview_windows().keys().map(String::as_str), surface) >= POPUPS_PER_SURFACE {
        eprintln!("[shell] browser surface {surface} already holds {POPUPS_PER_SURFACE} popups: {url} opens as a tab");
    } else if sized {
        match open_popup(app, surface, private, &url, features) {
            Ok(window) => return NewWindowResponse::Create { window },
            Err(error) => eprintln!("[shell] browser surface {surface}: the popup for {url} opens as a tab instead: {error}"),
        }
    }
    announce(app, Event::NewWindow { id: surface.to_owned(), url: url.to_string() });
    NewWindowResponse::Deny
}

/// Builds the popup a page asked for. WebView2 and WebKit only hand it the
/// page's request, and with it `window.opener`, when it shares the opener's
/// environment or configuration, which `window_features` passes on, and its
/// InPrivate state, which is the surface's.
fn open_popup(app: &AppHandle, surface: &str, private: bool, url: &Url, features: NewWindowFeatures) -> Result<WebviewWindow, String> {
    let label = popup_label(surface);
    // A sign-in from the tab on screen comes to the front. One from a tab an
    // agent drives off screen opens without taking the focus.
    let on_screen = super::label_of(surface).is_ok_and(|view| super::surfaces().visible(&view));
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(checked_url(surface, BLANK)?))
        .window_features(features)
        .title(popup_title(Some(url), ""))
        .visible(!crate::window::hidden())
        .focused(on_screen)
        .disable_drag_drop_handler()
        .incognito(private);
    // Owned by the Boite window, so it stays above it and minimizes with it.
    #[cfg(windows)]
    if let Some(hwnd) = app.get_window(super::MAIN_LABEL).and_then(|main| main.hwnd().ok()) {
        builder = builder.owner_raw(hwnd);
    }
    let id = surface.to_owned();
    builder = builder.on_navigation(move |url| {
        let allowed = SCHEMES.contains(&url.scheme());
        if !allowed {
            eprintln!("[shell] a popup of the browser surface {id} refused {url}: only {} are followed", SCHEMES.join(", "));
        }
        allowed
    });
    builder = builder.on_document_title_changed(|window, title| { let _ = window.set_title(&popup_title(window.url().ok().as_ref(), &title)); });
    let handle = app.clone();
    let id = surface.to_owned();
    builder = builder.on_new_window(move |url, features| new_window(&handle, &id, private, url, features));
    let window = builder.build().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    if let Err(error) = crate::platform::browser_page::popup(&window) {
        let _ = window.close();
        return Err(error);
    }
    Ok(window)
}

#[cfg(test)]
mod tests {
    use super::{popup_label, popup_surface, popup_title, popups_of, POPUPS_PER_SURFACE};
    use crate::browser::MAIN_LABEL;
    use tauri::Url;

    /// Surface ids carry `:`, so a popup of `browser:a` must not be taken for
    /// one of `browser:a:b` when the tab `browser:a` closes.
    #[test]
    fn a_popup_names_the_surface_it_belongs_to_exactly() {
        for surface in ["browser:a", "browser:a:b", "b/1_2"] {
            assert_eq!(popup_surface(&popup_label(surface)), Some(surface));
        }
        assert_ne!(popup_label("browser:a"), popup_label("browser:a"));
        for other in [MAIN_LABEL, "boite-browser:a", "boite-popup:x:browser:a", "boite-popup:7"] {
            assert_eq!(popup_surface(other), None, "{other}");
        }
    }

    /// Only the surface's own popups count towards its limit, popups of popups included.
    #[test]
    fn a_surface_counts_only_its_own_popups() {
        let labels: Vec<String> = (0..POPUPS_PER_SURFACE).map(|_| popup_label("browser:a"))
            .chain([popup_label("browser:a:b"), MAIN_LABEL.to_owned(), "boite-browser:a".to_owned()]).collect();
        assert_eq!(popups_of(labels.iter().map(String::as_str), "browser:a"), POPUPS_PER_SURFACE);
        assert_eq!(popups_of(labels.iter().map(String::as_str), "browser:a:b"), 1);
        assert_eq!(popups_of(labels.iter().map(String::as_str), "browser:c"), 0);
    }

    /// The host stays in the title whatever the page calls itself.
    #[test]
    fn a_popup_title_keeps_its_host() {
        let google = Url::parse("https://accounts.google.com/o/oauth2?x=1").unwrap();
        let fake = Url::parse("https://evil.example/login").unwrap();
        let blank = Url::parse("about:blank").unwrap();
        assert_eq!(popup_title(Some(&google), ""), "accounts.google.com");
        assert_eq!(popup_title(Some(&google), "Sign in - Google Accounts"), "accounts.google.com – Sign in - Google Accounts");
        assert_eq!(popup_title(Some(&fake), "accounts.google.com"), "evil.example – accounts.google.com");
        assert_eq!(popup_title(Some(&blank), "Sign in - Google Accounts"), "about:blank – Sign in - Google Accounts");
        assert_eq!(popup_title(None, "  "), "about:blank");
    }
}
