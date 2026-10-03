//! Named WebView2 profiles inside the one user data folder the shell already
//! uses. Every profile keeps its own cookies, storage and cache, while one
//! browser process serves them all and keeps the `--remote-debugging-port`.
//!
//! wry 0.55 creates each controller from options it asks the environment for,
//! and sets their InPrivate flag and nothing else. So a browser surface in a
//! named profile is handed the main webview's environment behind a thin COM
//! wrapper: every call goes straight through, except that the options it
//! creates carry the profile name. Nothing of wry or Tauri is patched.
#![allow(non_snake_case)]

use std::sync::mpsc;
use std::time::Duration;
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};
use webview2_com::ClearBrowsingDataCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::core::{IUnknown, Interface, Ref, Result, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::IStream;

/// An environment for one named profile, carried to the thread that builds the
/// webview. It is created on the main thread and only ever called there: wry
/// creates the controller on the event loop.
pub(crate) struct ProfileEnvironment(pub(crate) ICoreWebView2Environment);
// SAFETY: the interface is moved, never called, off the main thread.
unsafe impl Send for ProfileEnvironment {}

#[windows_core::implement(ICoreWebView2Environment10)]
struct Profiled {
    inner: ICoreWebView2Environment10,
    profile: HSTRING,
}

impl Profiled {
    fn options(&self) -> Result<ICoreWebView2ControllerOptions> {
        unsafe {
            let options = self.inner.CreateCoreWebView2ControllerOptions()?;
            options.SetProfileName(&self.profile)?;
            Ok(options)
        }
    }
}

impl ICoreWebView2Environment_Impl for Profiled_Impl {
    // wry always asks for options first. A controller made without them would
    // land in the default profile, so this one gets them too.
    fn CreateCoreWebView2Controller(&self, parent: HWND, handler: Ref<'_, ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>) -> Result<()> {
        unsafe { self.inner.CreateCoreWebView2ControllerWithOptions(parent, &self.options()?, handler.as_ref()) }
    }
    fn CreateWebResourceResponse(&self, content: Ref<'_, IStream>, status: i32, reason: &PCWSTR, headers: &PCWSTR) -> Result<ICoreWebView2WebResourceResponse> {
        unsafe { self.inner.CreateWebResourceResponse(content.as_ref(), status, *reason, *headers) }
    }
    fn BrowserVersionString(&self, value: *mut PWSTR) -> Result<()> {
        unsafe { self.inner.BrowserVersionString(value) }
    }
    fn add_NewBrowserVersionAvailable(&self, handler: Ref<'_, ICoreWebView2NewBrowserVersionAvailableEventHandler>, token: *mut i64) -> Result<()> {
        unsafe { self.inner.add_NewBrowserVersionAvailable(handler.as_ref(), token) }
    }
    fn remove_NewBrowserVersionAvailable(&self, token: i64) -> Result<()> {
        unsafe { self.inner.remove_NewBrowserVersionAvailable(token) }
    }
}

impl ICoreWebView2Environment2_Impl for Profiled_Impl {
    fn CreateWebResourceRequest(&self, uri: &PCWSTR, method: &PCWSTR, body: Ref<'_, IStream>, headers: &PCWSTR) -> Result<ICoreWebView2WebResourceRequest> {
        unsafe { self.inner.CreateWebResourceRequest(*uri, *method, body.as_ref(), *headers) }
    }
}

impl ICoreWebView2Environment3_Impl for Profiled_Impl {
    fn CreateCoreWebView2CompositionController(&self, parent: HWND, handler: Ref<'_, ICoreWebView2CreateCoreWebView2CompositionControllerCompletedHandler>) -> Result<()> {
        unsafe { self.inner.CreateCoreWebView2CompositionControllerWithOptions(parent, &self.options()?, handler.as_ref()) }
    }
    fn CreateCoreWebView2PointerInfo(&self) -> Result<ICoreWebView2PointerInfo> {
        unsafe { self.inner.CreateCoreWebView2PointerInfo() }
    }
}

impl ICoreWebView2Environment4_Impl for Profiled_Impl {
    fn GetAutomationProviderForWindow(&self, hwnd: HWND) -> Result<IUnknown> {
        unsafe { self.inner.GetAutomationProviderForWindow(hwnd) }
    }
}

impl ICoreWebView2Environment5_Impl for Profiled_Impl {
    fn add_BrowserProcessExited(&self, handler: Ref<'_, ICoreWebView2BrowserProcessExitedEventHandler>, token: *mut i64) -> Result<()> {
        unsafe { self.inner.add_BrowserProcessExited(handler.as_ref(), token) }
    }
    fn remove_BrowserProcessExited(&self, token: i64) -> Result<()> {
        unsafe { self.inner.remove_BrowserProcessExited(token) }
    }
}

impl ICoreWebView2Environment6_Impl for Profiled_Impl {
    fn CreatePrintSettings(&self) -> Result<ICoreWebView2PrintSettings> {
        unsafe { self.inner.CreatePrintSettings() }
    }
}

impl ICoreWebView2Environment7_Impl for Profiled_Impl {
    fn UserDataFolder(&self, value: *mut PWSTR) -> Result<()> {
        unsafe { self.inner.UserDataFolder(value) }
    }
}

impl ICoreWebView2Environment8_Impl for Profiled_Impl {
    fn add_ProcessInfosChanged(&self, handler: Ref<'_, ICoreWebView2ProcessInfosChangedEventHandler>, token: *mut i64) -> Result<()> {
        unsafe { self.inner.add_ProcessInfosChanged(handler.as_ref(), token) }
    }
    fn remove_ProcessInfosChanged(&self, token: i64) -> Result<()> {
        unsafe { self.inner.remove_ProcessInfosChanged(token) }
    }
    fn GetProcessInfos(&self) -> Result<ICoreWebView2ProcessInfoCollection> {
        unsafe { self.inner.GetProcessInfos() }
    }
}

impl ICoreWebView2Environment9_Impl for Profiled_Impl {
    fn CreateContextMenuItem(&self, label: &PCWSTR, icon: Ref<'_, IStream>, kind: COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND) -> Result<ICoreWebView2ContextMenuItem> {
        unsafe { self.inner.CreateContextMenuItem(*label, icon.as_ref(), kind) }
    }
}

impl ICoreWebView2Environment10_Impl for Profiled_Impl {
    fn CreateCoreWebView2ControllerOptions(&self) -> Result<ICoreWebView2ControllerOptions> {
        self.options()
    }
    fn CreateCoreWebView2ControllerWithOptions(&self, parent: HWND, options: Ref<'_, ICoreWebView2ControllerOptions>, handler: Ref<'_, ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>) -> Result<()> {
        unsafe {
            if let Some(options) = options.as_ref() { options.SetProfileName(&self.profile)?; }
            self.inner.CreateCoreWebView2ControllerWithOptions(parent, options.as_ref(), handler.as_ref())
        }
    }
    fn CreateCoreWebView2CompositionControllerWithOptions(&self, parent: HWND, options: Ref<'_, ICoreWebView2ControllerOptions>, handler: Ref<'_, ICoreWebView2CreateCoreWebView2CompositionControllerCompletedHandler>) -> Result<()> {
        unsafe {
            if let Some(options) = options.as_ref() { options.SetProfileName(&self.profile)?; }
            self.inner.CreateCoreWebView2CompositionControllerWithOptions(parent, options.as_ref(), handler.as_ref())
        }
    }
}

/// The main webview's environment, opening `profile` for every controller made
/// from it. The main webview is the one the Boite UI runs in, so it exists
/// whenever the UI asks for a surface.
pub(crate) async fn environment(app: &AppHandle, profile: &str) -> std::result::Result<ProfileEnvironment, String> {
    let main = app.get_webview(crate::browser::MAIN_LABEL)
        .ok_or_else(|| format!("the browser profile {profile:?} has no environment to open in: the main webview is gone"))?;
    let (sender, receiver) = mpsc::channel();
    let name = HSTRING::from(profile);
    main.with_webview(move |platform| {
        let made = (|| -> Result<ICoreWebView2Environment> {
            let inner: ICoreWebView2Environment10 = platform.environment().cast()?;
            let wrapped: ICoreWebView2Environment10 = Profiled { inner, profile: name }.into();
            wrapped.cast()
        })();
        let _ = sender.send(made.map(ProfileEnvironment).map_err(|error| error.to_string()));
    }).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(10))
        .map_err(|_| "the browser profile environment did not answer within 10 seconds".to_owned())?)
        .await.map_err(|error| error.to_string())?
        .map_err(|error| format!("the browser profile {profile:?} could not be prepared: {error}"))
}

/// Erases a profile's cookies, storage and cache now, and marks its folder for
/// deletion, which WebView2 completes when the browser process exits. A
/// hidden one-pixel webview opens the profile to reach it, then closes.
pub(crate) async fn delete(app: &AppHandle, profile: &str) -> std::result::Result<(), String> {
    let window = app.get_window(crate::browser::MAIN_LABEL)
        .ok_or_else(|| format!("the browser profile {profile:?} cannot be deleted: the main window is gone"))?;
    let label = format!("boite-profile-delete:{profile}");
    if let Some(stale) = app.get_webview(&label) { let _ = stale.close(); }
    let environment = environment(app, profile).await?;
    let blank = WebviewUrl::External("about:blank".parse().map_err(|_| "about:blank is not a url".to_owned())?);
    let builder = WebviewBuilder::new(label, blank).with_environment(environment.0);
    let view = window.add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0))
        .map_err(|error| format!("the browser profile {profile:?} could not be opened to delete it: {error}"))?;
    let _ = view.hide();
    let (sender, receiver) = mpsc::channel();
    let failed = sender.clone();
    let opened = view.with_webview(move |platform| {
        let started = (|| -> Result<()> { unsafe {
            let webview: ICoreWebView2_13 = platform.controller().CoreWebView2()?.cast()?;
            let profile = webview.Profile()?;
            let clearing: ICoreWebView2Profile2 = profile.cast()?;
            let handler = ClearBrowsingDataCompletedHandler::create(Box::new(move |result| {
                let deleted = result.and_then(|_| profile.cast::<ICoreWebView2Profile8>()?.Delete());
                let _ = sender.send(deleted.map_err(|error| error.to_string()));
                Ok(())
            }));
            clearing.ClearBrowsingDataAll(&handler)
        }})();
        if let Err(error) = started { let _ = failed.send(Err(error.to_string())); }
    });
    let result = match opened {
        Err(error) => Err(error.to_string()),
        Ok(()) => tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(30))
            .map_err(|_| "clearing the profile did not finish within 30 seconds".to_owned())?)
            .await.map_err(|error| error.to_string())?,
    };
    let _ = view.close();
    result.map_err(|error| format!("the browser profile {profile:?} could not be deleted: {error}"))
}
