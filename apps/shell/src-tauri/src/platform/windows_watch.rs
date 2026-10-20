//! What Windows can say about a shell in trouble: whether it considers the
//! main window hung, which other processes own windows inside it, a minidump
//! of the shell, and WebView2's own report when one of its processes dies.
//! Everything here but `remember_*` and `watch_webview` runs on the watchdog's
//! threads and must never send a message to the main thread.

use std::path::Path;
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};

use serde_json::json;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    ContentLoadingEventHandler, CoTaskMemPWSTR, NavigationCompletedEventHandler, NavigationStartingEventHandler,
    ProcessFailedEventHandler, WebResourceRequestedEventHandler,
};
use windows::core::{Interface, BOOL, PWSTR};

use crate::shell_log::{self, Level};

static MAIN_WINDOW: AtomicIsize = AtomicIsize::new(0);
static MAIN_THREAD: AtomicU32 = AtomicU32::new(0);

/// Called on the main thread at startup, so a dump's reader knows which stack to open.
pub(crate) fn remember_main_thread() {
    MAIN_THREAD.store(unsafe { windows_sys::Win32::System::Threading::GetCurrentThreadId() }, Ordering::Release);
}

pub(crate) fn main_thread_id() -> Option<u32> {
    Some(MAIN_THREAD.load(Ordering::Acquire)).filter(|id| *id != 0)
}

/// Kept once the window exists, so the watchdog never has to ask the blocked
/// main thread for it.
pub(crate) fn remember_main_window(window: &tauri::WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() { MAIN_WINDOW.store(hwnd.0 as isize, Ordering::Release); }
}

/// `IsHungAppWindow`: Windows' own "Not responding", true once the window has
/// not read its messages for 5 seconds.
pub(crate) fn main_window_hung() -> Option<bool> {
    let hwnd = MAIN_WINDOW.load(Ordering::Acquire);
    if hwnd == 0 { return None; }
    // A stale handle only answers false: the call reads, it never sends.
    Some(unsafe { windows_sys::Win32::UI::WindowsAndMessaging::IsHungAppWindow(hwnd as _) } != 0)
}

unsafe extern "system" fn collect_child(
    hwnd: windows_sys::Win32::Foundation::HWND, found: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::core::BOOL {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsHungAppWindow};
    let found = unsafe { &mut *(found as *mut Vec<(u32, bool)>) };
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    if pid != 0 && pid != std::process::id() { found.push((pid, unsafe { IsHungAppWindow(hwnd) } != 0)); }
    1
}

/// `(pid, hung)` for every descendant window of the main window that another
/// process owns: WebView2's browser process hosts the page's window there.
/// `EnumChildWindows`, `GetWindowThreadProcessId` and `IsHungAppWindow` read
/// the window tree; none of them waits on the window's thread.
pub(crate) fn foreign_child_windows() -> Option<Vec<(u32, bool)>> {
    let hwnd = MAIN_WINDOW.load(Ordering::Acquire);
    if hwnd == 0 { return None; }
    let mut found: Vec<(u32, bool)> = Vec::new();
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::EnumChildWindows(
            hwnd as _, Some(collect_child), &mut found as *mut Vec<(u32, bool)> as isize);
    }
    Some(found)
}

/// Writes a minidump of this process to `path`, a new file, and returns its
/// size. Called from a thread of its own: `MiniDumpWriteDump` suspends every
/// other thread while it reads them.
pub(crate) fn write_dump(path: &Path) -> Result<u64, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Diagnostics::Debug::{
        MiniDumpWithHandleData, MiniDumpWithThreadInfo, MiniDumpWithUnloadedModules, MiniDumpWriteDump,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetCurrentProcessId};
    let file = std::fs::OpenOptions::new().write(true).create_new(true).open(path)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    let written = unsafe {
        MiniDumpWriteDump(GetCurrentProcess(), GetCurrentProcessId(), file.as_raw_handle() as _,
            MiniDumpWithThreadInfo | MiniDumpWithHandleData | MiniDumpWithUnloadedModules,
            std::ptr::null(), std::ptr::null(), std::ptr::null())
    };
    if written == 0 {
        return Err(format!("MiniDumpWriteDump into {} failed: {}", path.display(), std::io::Error::last_os_error()));
    }
    file.metadata().map(|meta| meta.len()).map_err(|error| format!("{}: {error}", path.display()))
}

/// The OS and its build number, for the startup record.
pub(crate) fn os_build() -> (&'static str, String) {
    let version = windows_version::OsVersion::current();
    ("windows", format!("{}.{}.{}", version.major, version.minor, version.build))
}

fn kind_name(kind: COREWEBVIEW2_PROCESS_FAILED_KIND) -> (&'static str, Level, &'static str) {
    match kind {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED =>
            ("browser-process-exited", Level::Error, "every page of the window is gone until the shell restarts"),
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED =>
            ("render-process-exited", Level::Error, "the page stays blank until it reloads"),
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE =>
            ("render-process-unresponsive", Level::Error, "the page stopped answering input"),
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED =>
            ("frame-render-process-exited", Level::Warn, "a frame inside the page went blank"),
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED =>
            ("gpu-process-exited", Level::Warn, "WebView2 starts a new GPU process and may flicker"),
        COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED => ("utility-process-exited", Level::Warn, "WebView2 restarts it"),
        COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED => ("sandbox-helper-process-exited", Level::Warn, "WebView2 restarts it"),
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED => ("ppapi-plugin-process-exited", Level::Warn, "a plugin stopped"),
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED => ("ppapi-broker-process-exited", Level::Warn, "a plugin broker stopped"),
        _ => ("unknown-process-exited", Level::Warn, "WebView2 did not say which process"),
    }
}

fn reason_name(reason: COREWEBVIEW2_PROCESS_FAILED_REASON) -> &'static str {
    match reason {
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE => "unresponsive",
        COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED => "terminated",
        COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED => "crashed",
        COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED => "launch-failed",
        COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY => "out-of-memory",
        COREWEBVIEW2_PROCESS_FAILED_REASON_PROFILE_DELETED => "profile-deleted",
        _ => "unexpected",
    }
}

fn report(args: &ICoreWebView2ProcessFailedEventArgs) -> windows::core::Result<()> {
    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
    unsafe { args.ProcessFailedKind(&mut kind)? };
    let (name, level, effect) = kind_name(kind);
    let mut data = json!({ "kind": name, "kindCode": kind.0 });
    let mut detail = String::new();
    // Runtimes before 1.0.1072 only know the kind.
    if let Ok(more) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
        let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
        let mut code = 0i32;
        if unsafe { more.Reason(&mut reason) }.is_ok() {
            data["reason"] = json!(reason_name(reason));
            detail.push_str(&format!(", reason {}", reason_name(reason)));
        }
        if unsafe { more.ExitCode(&mut code) }.is_ok() {
            data["exitCode"] = json!(code);
            detail.push_str(&format!(", exit code {code} (0x{:08X})", code as u32));
        }
        let mut raw = PWSTR::null();
        if unsafe { more.ProcessDescription(&mut raw) }.is_ok() && !raw.is_null() {
            let description = CoTaskMemPWSTR::from(raw).to_string();
            if !description.is_empty() { data["process"] = json!(description); }
        }
    }
    shell_log::log(level, "webview", "shell.webview.process-failed",
        format!("WebView2 {}{detail}; {effect}", name.replace('-', " ")), None, data);
    // No flush: this runs on the main thread, which must not wait even 200 ms.
    // The writer thread writes the record as soon as it is queued.
    Ok(())
}

/// Registers the `ProcessFailed` handler on the main window's WebView2. The
/// browser and GPU processes are shared by every surface, so one is enough.
/// The main page's navigations are logged too (`watch_navigations`).
pub(crate) fn watch_webview(window: &tauri::WebviewWindow) {
    let registered = window.with_webview(|platform| {
        let added = (|| -> windows::core::Result<()> { unsafe {
            let webview = platform.controller().CoreWebView2()?;
            let handler = ProcessFailedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args { let _ = report(&args); }
                Ok(())
            }));
            let mut token = 0;
            webview.add_ProcessFailed(&handler, &mut token)?;
            watch_navigations(&webview)
        }})();
        if let Err(error) = added {
            shell_log::warn("webview", "shell.webview.watch-unavailable",
                format!("WebView2 process failures or navigations will not be logged: {error}"), json!({}));
        }
    });
    if let Err(error) = registered {
        shell_log::warn("webview", "shell.webview.watch-unavailable",
            format!("WebView2 process failures or navigations will not be logged: {error}"), json!({}));
    }
}

/// The URL a record names: no query, fragment or credentials.
fn bare(uri: PWSTR) -> String {
    if uri.is_null() { return String::new(); }
    let text = CoTaskMemPWSTR::from(uri).to_string();
    match tauri::Url::parse(&text) {
        Ok(mut url) => {
            url.set_query(None);
            url.set_fragment(None);
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.to_string()
        }
        Err(_) => text.chars().take(200).collect(),
    }
}

fn error_name(status: COREWEBVIEW2_WEB_ERROR_STATUS) -> &'static str {
    match status {
        COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN => "unknown",
        COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED => "operation-canceled",
        COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_ABORTED => "connection-aborted",
        COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_RESET => "connection-reset",
        COREWEBVIEW2_WEB_ERROR_STATUS_DISCONNECTED => "disconnected",
        COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT => "cannot-connect",
        COREWEBVIEW2_WEB_ERROR_STATUS_HOST_NAME_NOT_RESOLVED => "host-name-not-resolved",
        COREWEBVIEW2_WEB_ERROR_STATUS_SERVER_UNREACHABLE => "server-unreachable",
        COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT => "timeout",
        COREWEBVIEW2_WEB_ERROR_STATUS_ERROR_HTTP_INVALID_SERVER_RESPONSE => "invalid-server-response",
        COREWEBVIEW2_WEB_ERROR_STATUS_REDIRECT_FAILED => "redirect-failed",
        COREWEBVIEW2_WEB_ERROR_STATUS_UNEXPECTED_ERROR => "unexpected-error",
        _ => "other",
    }
}

/// Logs each navigation of the main page as `shell.webview.navigation`: when
/// it starts and to which URL, when its document request reaches the host,
/// whether its content is an error page, and how it ends, with WebView2's
/// error status and the HTTP status. A page left on about:blank on Windows
/// runners logged only `page-load` started and finished, 17 and 22 s after
/// the shell started, which says neither when the navigation was asked for
/// nor why it ended without a document (2026-10-19). The first record says
/// where the page is when the watch begins, in case its first navigation
/// started before.
fn watch_navigations(webview: &ICoreWebView2) -> windows::core::Result<()> {
    let mut source = PWSTR::null();
    let at = if unsafe { webview.Source(&mut source) }.is_ok() { bare(source) } else { String::new() };
    shell_log::info("webview", "shell.webview.navigation", format!("watching the main page's navigations from {at}"),
        json!({ "phase": "watching", "url": at }));
    let mut token = 0;
    let starting = NavigationStartingEventHandler::create(Box::new(|_, args| {
        let Some(args) = args else { return Ok(()) };
        let (mut id, mut uri) = (0u64, PWSTR::null());
        unsafe { args.NavigationId(&mut id)?; args.Uri(&mut uri)?; }
        let url = bare(uri);
        shell_log::info("webview", "shell.webview.navigation", format!("navigation {id} to {url} started"),
            json!({ "phase": "starting", "id": id, "url": url }));
        Ok(())
    }));
    unsafe { webview.add_NavigationStarting(&starting, &mut token)? };
    // Wry's handler, registered when the webview was built, runs first and
    // hands the request to Tauri's asset protocol, which answers from its own
    // thread (`shell.webview.navigation` `answered`, `window.rs`).
    let requested = WebResourceRequestedEventHandler::create(Box::new(|_, args| {
        let Some(args) = args else { return Ok(()) };
        let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT::default();
        unsafe { args.ResourceContext(&mut context)? };
        if context != COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT { return Ok(()) }
        let mut uri = PWSTR::null();
        unsafe { args.Request()?.Uri(&mut uri)? };
        let url = bare(uri);
        shell_log::info("webview", "shell.webview.navigation", format!("the host got the document request for {url}"),
            json!({ "phase": "requested", "url": url }));
        Ok(())
    }));
    unsafe { webview.add_WebResourceRequested(&requested, &mut token)? };
    let content = ContentLoadingEventHandler::create(Box::new(|_, args| {
        let Some(args) = args else { return Ok(()) };
        let (mut id, mut error_page) = (0u64, BOOL::default());
        unsafe { args.NavigationId(&mut id)?; args.IsErrorPage(&mut error_page)?; }
        let error_page = error_page.as_bool();
        shell_log::info("webview", "shell.webview.navigation",
            format!("navigation {id} loads {}", if error_page { "an error page" } else { "its document" }),
            json!({ "phase": "content", "id": id, "errorPage": error_page }));
        Ok(())
    }));
    unsafe { webview.add_ContentLoading(&content, &mut token)? };
    let completed = NavigationCompletedEventHandler::create(Box::new(|_, args| {
        let Some(args) = args else { return Ok(()) };
        let (mut id, mut success, mut status) = (0u64, BOOL::default(), COREWEBVIEW2_WEB_ERROR_STATUS::default());
        unsafe { args.NavigationId(&mut id)?; args.IsSuccess(&mut success)?; args.WebErrorStatus(&mut status)?; }
        let mut code = 0i32;
        // Runtimes before 1.0.1185 do not say the HTTP status, and 0 means no response came.
        let http = args.cast::<ICoreWebView2NavigationCompletedEventArgs2>().ok()
            .and_then(|more| unsafe { more.HttpStatusCode(&mut code) }.ok().map(|()| code))
            .filter(|code| *code > 0);
        let success = success.as_bool();
        let (level, outcome) = if success { (Level::Info, "succeeded".to_string()) }
            else { (Level::Warn, format!("failed: {} ({})", error_name(status), status.0)) };
        let http_text = http.map_or_else(|| "unknown".to_string(), |code| code.to_string());
        shell_log::log(level, "webview", "shell.webview.navigation", format!("navigation {id} {outcome}, HTTP {http_text}"), None,
            json!({ "phase": "completed", "id": id, "success": success, "webErrorStatus": error_name(status), "webErrorCode": status.0, "httpStatus": http }));
        Ok(())
    }));
    unsafe { webview.add_NavigationCompleted(&completed, &mut token) }
}
