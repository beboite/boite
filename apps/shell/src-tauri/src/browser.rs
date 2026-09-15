//! The browser surfaces. A surface's page is never a child of the Svelte tree:
//! the UI measures a slot, hands the rectangle over, and the shell parks a
//! child `Webview` on the main window over exactly that rectangle. Everything
//! here is window work, which is the only kind of work the shell does.
//!
//! Two rules hold the whole module together.
//!
//! A page the user browsed to must not reach a Tauri command. Plugin commands
//! are already refused for it, because a remote origin only matches a
//! capability that names it and the shell's capability names none, but an
//! application command like `core_endpoint` carries the core token and no
//! capability gates it at all. So every command of this shell asks which
//! webview invoked it and answers only `main`, the one the Boite UI runs in.
//!
//! A surface reaches http, https and about, and nothing else. The command
//! refuses another scheme by name before the webview is touched, and the
//! navigation handler refuses it again for a link the page itself followed.

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Runtime, Size, Url,
    Webview, WebviewUrl,
};

/// The webview the Boite UI runs in, and the only caller any command answers.
pub const MAIN_LABEL: &str = "main";

/// A child webview's label: this, then the surface id the UI chose.
const LABEL_PREFIX: &str = "boite-browser:";

/// The single event the shell emits for every browser surface.
const EVENT: &str = "browser://event";

/// What a browser surface may load. Everything else is refused by name.
const SCHEMES: [&str; 3] = ["http", "https", "about"];

/// The page a surface with no url of its own sits on.
const BLANK: &str = "about:blank";

/// The shape `BrowserEvent` takes in `packages/ui/src/lib/browser-bridge.ts`.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Event {
    Url { id: String, url: String },
    Title { id: String, title: String },
    Loading { id: String, loading: bool },
    Failed { id: String, reason: String },
    NewWindow { id: String, url: String },
}

/// A slot's place in the window's content area, in logical pixels, which is
/// what `getBoundingClientRect` gives the UI.
#[derive(Deserialize)]
pub struct SurfaceRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// `emit` reaches only the webviews that registered a listener for this event,
/// and registering one is the `core:event:allow-listen` permission, which a
/// remote origin never resolves. The UI is the only page that hears this.
fn announce(app: &AppHandle, event: Event) {
    if let Err(error) = app.emit(EVENT, event) {
        eprintln!("[shell] a browser event could not be emitted: {error}");
    }
}

fn fail(app: &AppHandle, id: &str, reason: String) {
    eprintln!("[shell] browser surface {id}: {reason}");
    announce(
        app,
        Event::Failed {
            id: id.to_string(),
            reason,
        },
    );
}

/// The Boite UI, or nothing. See the module's first rule.
pub fn only_main(webview: &Webview) -> Result<(), String> {
    let label = webview.label();
    if label == MAIN_LABEL {
        return Ok(());
    }
    Err(format!(
        "the webview {label:?} may not invoke this shell command: only the Boite UI, in the {MAIN_LABEL:?} webview, can"
    ))
}

/// Every browser surface belongs to the page that asked for it. When the UI
/// reloads, that page is gone and its surfaces with it, so the child webviews
/// are closed here rather than left hidden behind a page that has forgotten
/// them. Called on every load of the main webview, the first one included,
/// where there is nothing to close.
pub fn close_all<R: Runtime>(app: &AppHandle<R>) {
    for (label, view) in app.webviews() {
        if !label.starts_with(LABEL_PREFIX) {
            continue;
        }
        eprintln!("[shell] the browser surface {label} is closed: its page reloaded");
        if let Err(error) = view.close() {
            eprintln!("[shell] the browser surface {label} could not be closed: {error}");
        }
    }
}

/// A webview label is not free-form: `tauri_runtime::window::is_label_valid`
/// takes letters, digits, `-`, `/`, `:` and `_` and panics on the rest, so an
/// id that would panic is refused here, naming the character.
fn label_of(id: &str) -> Result<String, String> {
    if id.is_empty() {
        return Err("a browser surface needs an id, and an empty one was given".to_string());
    }
    if let Some(bad) = id
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '/')))
    {
        return Err(format!(
            "the browser surface id {id:?} carries {bad:?}, which a webview label cannot: only ASCII letters, digits, `-`, `_`, `:` and `/`"
        ));
    }
    Ok(format!("{LABEL_PREFIX}{id}"))
}

fn view_of(app: &AppHandle, id: &str) -> Result<Webview, String> {
    let label = label_of(id)?;
    app.get_webview(&label).ok_or_else(|| {
        format!("the browser surface {id:?} is not open in this shell: no webview {label:?}")
    })
}

/// A url this surface may load, or a refusal naming the scheme.
fn checked_url(id: &str, raw: &str) -> Result<Url, String> {
    let text = raw.trim();
    let text = if text.is_empty() { BLANK } else { text };
    let url = Url::parse(text).map_err(|error| {
        format!("the browser surface {id:?} was given {text:?}, which is not a url: {error}")
    })?;
    if !SCHEMES.contains(&url.scheme()) {
        return Err(format!(
            "the browser surface {id:?} refuses the scheme {:?} of {text:?}: only {} are allowed",
            url.scheme(),
            SCHEMES.join(", ")
        ));
    }
    Ok(url)
}

// ---------------------------------------------------------------------------
// The commands. Every one of them names the surface and the reason when it
// fails, and none of them is a silent no-op.
//
// All of them are `async`, which is what puts them on Tauri's async runtime
// rather than on the main thread. `Window::add_child` posts its work to the
// event loop and blocks on the answer, so a synchronous command deadlocks the
// very thread it is waiting for: the first `browser_create` never returned and
// the end to end run timed out on it (2026-09-08). The others follow it for one
// reason, that a webview call blocking the event loop is a frozen window.
// ---------------------------------------------------------------------------

/// Creates the child webview, hidden and one pixel wide: the first
/// `browser_set_bounds` is what puts it on the screen, so a page never flashes
/// in a corner before the UI has measured its slot.
#[tauri::command]
pub async fn browser_create(
    app: AppHandle,
    webview: Webview,
    id: String,
    url: String,
) -> Result<(), String> {
    only_main(&webview)?;
    let label = label_of(&id)?;
    if app.get_webview(&label).is_some() {
        return Err(format!(
            "the browser surface {id:?} is already open in this shell: destroy it before creating it again"
        ));
    }
    let start = checked_url(&id, &url)?;
    let window = app.get_window(MAIN_LABEL).ok_or_else(|| {
        format!("the browser surface {id:?} has no window to sit in: the {MAIN_LABEL:?} window is gone")
    })?;

    let mut builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(start))
        // A file dragged onto the page is the page's business, not the folder
        // drop the shell listens for on the main webview.
        .disable_drag_drop_handler();

    // The same profile the main webview runs on, deliberately. A second user
    // data folder is a second WebView2 browser process: another hundred
    // megabytes idle, and it cannot bind the `--remote-debugging-port` the
    // first one already holds, which is the port the end to end suite drives.
    if let Some(directory) = crate::webview_profile() {
        builder = builder.data_directory(directory);
    }
    if let Some(args) = crate::test_browser_args() {
        builder = builder.additional_browser_args(&args);
    }

    let handle = app.clone();
    let surface = id.clone();
    builder = builder.on_navigation(move |url| {
        if !SCHEMES.contains(&url.scheme()) {
            fail(
                &handle,
                &surface,
                format!(
                    "the scheme {:?} of {url} is not one a browser surface follows: only {} are",
                    url.scheme(),
                    SCHEMES.join(", ")
                ),
            );
            return false;
        }
        announce(
            &handle,
            Event::Url {
                id: surface.clone(),
                url: url.to_string(),
            },
        );
        true
    });

    let handle = app.clone();
    let surface = id.clone();
    builder = builder.on_document_title_changed(move |_webview, title| {
        announce(
            &handle,
            Event::Title {
                id: surface.clone(),
                title,
            },
        );
    });

    let handle = app.clone();
    let surface = id.clone();
    builder = builder.on_page_load(move |_webview, payload| {
        let loading = matches!(payload.event(), PageLoadEvent::Started);
        announce(
            &handle,
            Event::Url {
                id: surface.clone(),
                url: payload.url().to_string(),
            },
        );
        announce(
            &handle,
            Event::Loading {
                id: surface.clone(),
                loading,
            },
        );
    });

    // A page asking for a window of its own gets none: the request comes back
    // to the UI, which opens another tab in the same panel.
    let handle = app.clone();
    let surface = id.clone();
    builder = builder.on_new_window(move |url, _features| {
        if checked_url(&surface, url.as_str()).is_err() {
            return NewWindowResponse::Deny;
        }
        announce(
            &handle,
            Event::NewWindow {
                id: surface.clone(),
                url: url.to_string(),
            },
        );
        NewWindowResponse::Deny
    });

    let view = window
        .add_child(
            builder,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|error| format!("the browser surface {id:?} could not be created: {error}"))?;
    view.hide()
        .map_err(|error| format!("the browser surface {id:?} could not be parked: {error}"))
}

#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    webview: Webview,
    id: String,
    url: String,
) -> Result<(), String> {
    only_main(&webview)?;
    let target = checked_url(&id, &url)?;
    view_of(&app, &id)?
        .navigate(target)
        .map_err(|error| format!("the browser surface {id:?} could not open {url:?}: {error}"))
}

/// Tauri 2.11 gives a webview no history call, so the page's own history is
/// what moves. A page that has nowhere to go simply does not move.
#[tauri::command]
pub async fn browser_back(app: AppHandle, webview: Webview, id: String) -> Result<(), String> {
    only_main(&webview)?;
    view_of(&app, &id)?
        .eval("history.back()")
        .map_err(|error| format!("the browser surface {id:?} could not go back: {error}"))
}

#[tauri::command]
pub async fn browser_forward(app: AppHandle, webview: Webview, id: String) -> Result<(), String> {
    only_main(&webview)?;
    view_of(&app, &id)?
        .eval("history.forward()")
        .map_err(|error| format!("the browser surface {id:?} could not go forward: {error}"))
}

#[tauri::command]
pub async fn browser_reload(app: AppHandle, webview: Webview, id: String) -> Result<(), String> {
    only_main(&webview)?;
    view_of(&app, &id)?
        .reload()
        .map_err(|error| format!("the browser surface {id:?} could not reload: {error}"))
}

/// The rectangle is in logical pixels relative to the window's content area,
/// which is what the UI reads off the slot: the webview and the page share the
/// window's scale factor, so nothing is converted on the way.
///
/// `null` parks the surface. It is hidden rather than moved off screen, so the
/// page stops painting instead of painting somewhere nobody looks.
#[tauri::command]
pub async fn browser_set_bounds(
    app: AppHandle,
    webview: Webview,
    id: String,
    rect: Option<SurfaceRect>,
) -> Result<(), String> {
    only_main(&webview)?;
    let view = view_of(&app, &id)?;
    let Some(rect) = rect.filter(|rect| rect.width >= 1.0 && rect.height >= 1.0) else {
        return view
            .hide()
            .map_err(|error| format!("the browser surface {id:?} could not be parked: {error}"));
    };
    view.set_bounds(Rect {
        position: Position::Logical(LogicalPosition::new(rect.x, rect.y)),
        size: Size::Logical(LogicalSize::new(rect.width, rect.height)),
    })
    .map_err(|error| {
        format!(
            "the browser surface {id:?} could not be moved to {} by {} at {}, {}: {error}",
            rect.width, rect.height, rect.x, rect.y
        )
    })?;
    view.show()
        .map_err(|error| format!("the browser surface {id:?} could not be shown: {error}"))
}

#[tauri::command]
pub async fn browser_set_zoom(
    app: AppHandle,
    webview: Webview,
    id: String,
    factor: f64,
) -> Result<(), String> {
    only_main(&webview)?;
    if !factor.is_finite() || factor <= 0.0 {
        return Err(format!(
            "the browser surface {id:?} was given the zoom factor {factor}, which is not a positive number"
        ));
    }
    view_of(&app, &id)?
        .set_zoom(factor)
        .map_err(|error| format!("the browser surface {id:?} could not zoom to {factor}: {error}"))
}

#[tauri::command]
pub async fn browser_destroy(app: AppHandle, webview: Webview, id: String) -> Result<(), String> {
    only_main(&webview)?;
    view_of(&app, &id)?
        .close()
        .map_err(|error| format!("the browser surface {id:?} could not be closed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{checked_url, label_of, LABEL_PREFIX};

    #[test]
    fn a_surface_id_becomes_a_label() {
        assert_eq!(
            label_of("browser:9f1c-2").unwrap(),
            format!("{LABEL_PREFIX}browser:9f1c-2")
        );
    }

    #[test]
    fn an_id_a_label_cannot_carry_is_refused_by_character() {
        let error = label_of("browser:a b").unwrap_err();
        assert!(error.contains("' '"), "{error}");
        assert!(label_of("").unwrap_err().contains("empty"));
    }

    #[test]
    fn only_http_https_and_about_are_loaded() {
        assert_eq!(checked_url("t1", "").unwrap().as_str(), "about:blank");
        assert!(checked_url("t1", "https://example.invalid/").is_ok());
        let error = checked_url("t1", "file:///C:/secret.txt").unwrap_err();
        assert!(error.contains("\"file\""), "{error}");
        assert!(error.contains("t1"), "{error}");
    }
}
