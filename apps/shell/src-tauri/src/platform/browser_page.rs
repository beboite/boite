//! A browser surface shows other people's pages, and they should find there
//! what an Edge tab gives them, nothing of the app around it. Tauri and wry
//! give every webview the app's bridge: `window.__TAURI_INTERNALS__`,
//! `window.ipc`, the plugins' scripts and WebView2's `chrome.webview`. A page in
//! a surface cannot run a shell command (see `browser.rs`), but the opener
//! plugin's script still caught every `target="_blank"` link and handed it to
//! the command the page is refused, so the link did nothing. `plain` takes all
//! of it back out before the first page loads.
use std::sync::mpsc;
use std::time::Duration;
use tauri::{Manager, Runtime, Webview, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
use webview2_com::{AddScriptToExecuteOnDocumentCreatedCompletedHandler, WindowCloseRequestedEventHandler};
use windows::core::HSTRING;

/// How many document scripts before the probe are taken out. Tauri 2.11 and
/// its plugins add about fifteen to a webview, all while it is being built.
const SCRIPTS: u64 = 64;

/// Runs first in every document. A popup still has `chrome.webview` with the
/// bridge turned off in its settings, as if WebView2 kept the ones it had when
/// it was handed the popup. The property is configurable and goes with it.
const PROBE: &str = "if (window.chrome) delete window.chrome.webview;";

/// Turns off WebView2's page bridge and removes the scripts added while the
/// webview was built, which are Tauri's, wry's and the plugins'. WebView2 does
/// not list a webview's scripts, and wry does not keep the ids it was given:
/// a probe script added now gets the next id, and the ones before it are
/// removed. Runs on the main thread, and pumps its messages while the probe is
/// added, as wry does when it adds the same scripts.
fn plain(webview: &ICoreWebView2) -> Result<(), String> {
    unsafe {
        let settings = webview.Settings().map_err(|error| error.to_string())?;
        settings.SetIsWebMessageEnabled(false).map_err(|error| error.to_string())?;
        settings.SetAreHostObjectsAllowed(false).map_err(|error| error.to_string())?;
    }
    let (sender, receiver) = mpsc::channel();
    let target = webview.clone();
    AddScriptToExecuteOnDocumentCreatedCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| unsafe {
            target.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(PROBE), &handler).map_err(webview2_com::Error::WindowsError)
        }),
        Box::new(move |result, id| {
            result?;
            let _ = sender.send(id);
            Ok(())
        }),
    ).map_err(|error| format!("the probe script was not added: {error:?}"))?;
    let probe = receiver.try_recv().map_err(|_| "the probe script was added without an id".to_owned())?;
    let last: u64 = probe.parse()
        .map_err(|_| format!("WebView2 gave the probe script the id {probe:?}, not a number, so the app's scripts could not be found"))?;
    for id in last.saturating_sub(SCRIPTS)..last {
        // An id this webview never had is ignored by WebView2.
        let _ = unsafe { webview.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(id.to_string())) };
    }
    Ok(())
}

/// Makes a new surface plain before it leaves about:blank.
pub(crate) async fn surface(view: &Webview) -> Result<(), String> {
    let (sender, receiver) = mpsc::channel();
    view.with_webview(move |platform| {
        let made = unsafe { platform.controller().CoreWebView2() }.map_err(|error| error.to_string()).and_then(|webview| plain(&webview));
        let _ = sender.send(made);
    }).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(10))
        .map_err(|_| "the page bridge was not removed within 10 seconds".to_owned())?)
        .await.map_err(|error| error.to_string())?
}

/// Makes a popup plain, and closes its window when the page calls
/// `window.close()`: wry only destroys the webview inside it, which left an
/// empty window behind once a sign-in popup had answered its opener. Called in
/// the new-window handler, on the main thread, before WebView2 is handed the
/// popup, so its first document already finds it plain.
pub(crate) fn popup<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let (sender, receiver) = mpsc::channel();
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    window.with_webview(move |platform| {
        let made = (|| -> Result<(), String> {
            let webview = unsafe { platform.controller().CoreWebView2() }.map_err(|error| error.to_string())?;
            plain(&webview)?;
            let handler = WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
                // Closed later, off this WebView2 callback, which must not
                // destroy the webview it is running in.
                let app = app.clone();
                let label = label.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(window) = app.get_webview_window(&label) { let _ = window.close(); }
                });
                Ok(())
            }));
            let mut token = 0;
            unsafe { webview.add_WindowCloseRequested(&handler, &mut token) }.map_err(|error| error.to_string())
        })();
        let _ = sender.send(made);
    }).map_err(|error| error.to_string())?;
    // `with_webview` runs at once on the main thread, where this is called.
    receiver.try_recv().map_err(|_| "the popup's webview did not answer".to_owned())?
}
