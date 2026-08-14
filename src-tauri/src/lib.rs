mod agent_api;
mod app_data;
mod commands;
mod fullscreen;
mod local_pty;
mod logging;

use std::sync::atomic::{AtomicBool, Ordering};

use boite_core::pty::PtyManager;
use boite_core::scope::ProjectRoots;
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

#[derive(Default)]
pub struct BootState {
    completed: AtomicBool,
}

impl BootState {
    pub fn mark_completed(&self) -> bool {
        !self.completed.swap(true, Ordering::SeqCst)
    }

    pub fn is_completed(&self) -> bool {
        self.completed.load(Ordering::SeqCst)
    }
}

/// Called by the titlebar once it has painted the layout for the state it is
/// in, so the lights never come back over a row that has not made room yet.
#[tauri::command]
fn set_traffic_lights_hidden(window: tauri::WebviewWindow, hidden: bool) {
    fullscreen::set_lights_hidden(&window, hidden);
}

/// Fills the strip of window that the client area does not reach.
///
/// A maximized borderless window is not given the whole monitor: tao holds a
/// pixel back on any edge that has an auto-hide taskbar, otherwise the bar has
/// nothing left to notice the pointer with. That pixel is outside the client
/// area, so the webview never covers it and nothing else paints it either —
/// which is the white line along the bottom of the screen, on every launch that
/// came up maximized. Painting it the app's own background is what makes it
/// disappear rather than merely move: the row has to be drawn by somebody, and
/// no window attribute reassigns it (`DWMWA_BORDER_COLOR`, frame recalculation
/// through `SWP_FRAMECHANGED` and a full `RDW_FRAME` redraw all leave it white).
///
/// Colour comes from `--color-background` in `src/app.css`, opaque, so the row
/// reads as more window rather than as a seam.
///
/// Blitted from a 32-bit DIB rather than filled with a brush, because the window
/// is `"transparent": true` on Windows and therefore per-pixel alpha: every GDI
/// call that takes a `COLORREF` writes a zero alpha byte, so `FillRect` turned
/// the white row into a see-through one instead of removing it. `BitBlt` copies
/// all four bytes of each source pixel, alpha included, which is the only way to
/// hand DWM an opaque row from GDI.
#[cfg(windows)]
pub(crate) fn paint_frame_gap(win: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, ClientToScreen, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject,
        GetWindowDC, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, GetWindowRect};

    // 0xAARRGGBB, matching `--color-background`. Stored per pixel in the DIB,
    // so the alpha byte survives the blit.
    const OPAQUE_BACKGROUND: u32 = 0xff0a_0a0a;

    // Maximized only. A windowed frame is inset on every side too, but that gap
    // is the undecorated shadow and the compositor owns it: filling it would
    // replace a soft edge with an opaque bar.
    if !win.is_maximized().unwrap_or(false) {
        return;
    }
    let Ok(hwnd) = win.hwnd() else { return };
    unsafe {
        let mut window = RECT::default();
        let mut client = RECT::default();
        if GetWindowRect(hwnd, &mut window).is_err() || GetClientRect(hwnd, &mut client).is_err() {
            return;
        }
        // Both rects in window coordinates: `GetWindowDC` hands back a device
        // context whose origin is the window, not the client area, and on a
        // maximized borderless window the two are eight pixels apart.
        let mut origin = POINT { x: 0, y: 0 };
        if !ClientToScreen(hwnd, &mut origin).as_bool() {
            return;
        }
        let top = origin.y + client.bottom - window.top;
        let bottom = window.bottom - window.top;
        if top >= bottom {
            return;
        }

        let width = window.right - window.left;
        let height = bottom - top;
        if width <= 0 {
            return;
        }

        let dc = GetWindowDC(Some(hwnd));
        if dc.is_invalid() {
            return;
        }
        let mem = CreateCompatibleDC(Some(dc));
        if mem.is_invalid() {
            ReleaseDC(Some(hwnd), dc);
            return;
        }

        // Negative height: top-down rows, so `bits` is a plain left-to-right
        // pixel run and the fill below needs no stride arithmetic.
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let bitmap = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0);
        if let (Ok(bitmap), false) = (bitmap, bits.is_null()) {
            let pixels = bits.cast::<u32>();
            for i in 0..(width as isize * height as isize) {
                pixels.offset(i).write(OPAQUE_BACKGROUND);
            }
            let previous = SelectObject(mem, bitmap.into());
            let _ = BitBlt(dc, 0, top, width, height, Some(mem), 0, 0, SRCCOPY);
            SelectObject(mem, previous);
            let _ = DeleteObject(bitmap.into());
        }

        let _ = DeleteDC(mem);
        ReleaseDC(Some(hwnd), dc);
    }
}

#[cfg(not(windows))]
pub(crate) fn paint_frame_gap(_win: &tauri::WebviewWindow) {}

fn show_main_window(handle: &tauri::AppHandle) {
    if let Some(win) = handle.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
        paint_frame_gap(&win);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before the first which() or PTY: launched from Finder we start with
    // launchd's bare PATH, which hides Homebrew and every agent CLI.
    boite_core::env::hydrate_login_path();

    // The list lives in `boite_core::migrations`, shared with boite-server.
    // It used to be written out here and again there, kept in step by comments
    // that were wrong: the two sides do not even number the same thing, since
    // each ran entries the other never did.
    let migrations: Vec<Migration> = boite_core::migrations::desktop()
        .into_iter()
        .map(|(version, description, sql)| Migration {
            version,
            description,
            sql,
            kind: MigrationKind::Up,
        })
        .collect();

    // Before the builder, not inside `setup`: plugin setup hooks run first, and
    // the sql plugin preloads `sqlite:boite.db`. Opening it creates it, so from
    // an app-level hook this always found a database at the new identifier and
    // refused to overwrite it — stranding the real one under the old name. The
    // outcome is carried into `setup` because there is no log session yet.
    let data_move = app_data::migrate_before_plugins();

    let builder = tauri::Builder::default()
        // Must be the first plugin so a second launch is intercepted before
        // anything else initializes. Two instances would share one SQLite
        // file and race kill_all on exit.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        // Everything but DECORATIONS and VISIBLE: both replay whatever the window
        // had last run, and both belong to the config, not to the restored
        // session. DECORATIONS: a state file written while the window was
        // frameless keeps calling set_decorations(false) at every launch — which
        // on macOS strips the traffic lights the config just asked for. VISIBLE:
        // the plugin calls show() as it restores, at window creation, which
        // defeats `"visible": false` and the whole finish_boot gate below — the
        // window came up before the frontend had painted, so every launch after
        // the first flashed the webview's blank backdrop.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::DECORATIONS
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:boite.db", migrations)
                .build(),
        );

    // Self-update, desktop only. The updater refuses any payload whose minisign
    // signature does not match the public key baked into the config, so the
    // endpoint is not a trusted input — losing the domain does not hand anyone
    // code execution. `process` is here purely for the relaunch that follows an
    // install on macOS and Linux.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    // Registered last so single_instance still wins the startup race, and bound
    // to loopback: the plugin's own default is 0.0.0.0, which would put an
    // unauthenticated WebSocket on the LAN and the tailnet. That socket answers
    // execute_js, and JS in the webview reaches the IPC that spawns PTYs.
    #[cfg(all(debug_assertions, feature = "mcp-bridge"))]
    let builder = builder.plugin(
        tauri_plugin_mcp_bridge::Builder::new()
            .bind_address("127.0.0.1")
            .build(),
    );

    builder
        .manage(PtyManager::new())
        .manage(local_pty::LocalSessions::new())
        .manage(BootState::default())
        .manage(ProjectRoots::default())
        .manage(commands::app::LastScreen::default())
        .manage(agent_api::DeviceAnswers::default())
        .manage(commands::records::Rows::default())
        .setup(|app| {
            // Built here rather than declared in tauri.conf.json, for exactly
            // one reason: an initialization script can only be attached to a
            // webview while it is being built, and the pane driver has to run
            // in every frame — it is how an agent reads the browser pane, and
            // an iframe is a frame of this webview, not a webview of its own.
            // The values mirror what the config used to say; the config's
            // `windows` array is empty now so nothing is created twice.
            let main_window = tauri::utils::config::WindowConfig {
                label: "main".into(),
                title: "Boite".into(),
                width: 1280.0,
                height: 800.0,
                min_width: Some(720.0),
                min_height: Some(480.0),
                decorations: false,
                transparent: true,
                visible: false,
                ..Default::default()
            };
            tauri::WebviewWindowBuilder::from_config(app, &main_window)?
                .initialization_script_for_all_frames(include_str!(
                    "../scripts/pane-driver.js"
                ))
                .build()?;

            let setup_handle = app.handle().clone();
            if let Err(e) = logging::begin_log_session(&setup_handle) {
                eprintln!("[boite/logging] begin_log_session failed: {e}");
            }
            match data_move {
                Ok(app_data::Outcome::Nothing) => {}
                Ok(app_data::Outcome::Moved { entries, from }) => {
                    let _ = logging::append_app_log(
                        &setup_handle,
                        "info",
                        "backend.appdata",
                        "Moved app data from the pre-1.1.0 identifier",
                        Some(&format!("{entries} entries from {}", from.display())),
                    );
                }
                Ok(app_data::Outcome::KeptBoth { legacy }) => {
                    let _ = logging::append_app_log(
                        &setup_handle,
                        "warn",
                        "backend.appdata",
                        "Found a database under the old identifier too; kept both",
                        Some(&legacy.display().to_string()),
                    );
                }
                Err(e) => {
                    let _ = logging::append_app_log(
                        &setup_handle,
                        "error",
                        "backend.appdata",
                        "Could not move app data from the old identifier",
                        Some(&e),
                    );
                }
            }
            logging::install_panic_hook(setup_handle.clone());
            fullscreen::watch(&setup_handle);

            // The strip is a property of the frame, so it comes back white
            // every time the frame is recomputed — maximizing, restoring,
            // crossing to a monitor of another scale. Painted on each of those
            // rather than once at startup.
            #[cfg(windows)]
            if let Some(win) = setup_handle.get_webview_window("main") {
                let target = win.clone();
                win.on_window_event(move |event| match event {
                    tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::Moved(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. } => paint_frame_gap(&target),
                    _ => {}
                });
            }
            agent_api::start(&setup_handle);
            let _ = logging::append_app_log(
                &setup_handle,
                "info",
                "backend.startup",
                "App setup started",
                None,
            );

            // Failsafe: if frontend fails to call finish_boot within 8s, show anyway.
            // 8s tolerates slow webkit2gtk paint loops on Linux software rendering.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(8000));
                let state = handle.state::<BootState>();
                if !state.is_completed() {
                    let _ = logging::append_app_log(
                        &handle,
                        "warn",
                        "backend.boot-failsafe",
                        "Failsafe triggered after 8000ms; forcing main window visibility",
                        None,
                    );
                    state.mark_completed();
                    show_main_window(&handle);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_traffic_lights_hidden,
            commands::pty::pty_warm_shell,
            commands::pty::pty_open,
            commands::pty::pty_detach,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::thread_reply,
            commands::pty::pty_kill,
            commands::app::finish_boot,
            commands::app::log_app_event,
            commands::app::read_app_log,
            commands::app::workspace_timeline,
            commands::app::clear_app_log,
            commands::app::workspace_snapshot,
            commands::app::record_screen,
            commands::app::log_file_path,
            commands::files::register_project_roots,
            commands::files::inspect_project,
            commands::files::home_dir,
            commands::files::folder_state,
            commands::files::create_project_folder,
            commands::files::read_dir,
            commands::files::explorer_search,
            commands::files::read_text_file,
            commands::files::read_file_base64,
            commands::files::write_text_file,
            commands::files::default_shell,
            commands::files::available_shells,
            commands::sessions::find_claude_session,
            commands::sessions::live_claude_sessions,
            commands::sessions::agent_turns,
            commands::sessions::agent_token_usage,
            commands::agents::agent_mcp_config,
            commands::agents::agent_api_ready,
            agent_api::approvals_open,
            agent_api::approval_decide,
            agent_api::agent_answer,
            commands::capture::capture_pane,
            commands::agents::agent_mcp_project_path,
            commands::agents::agent_mcp_registration,
            commands::agents::register_agent_mcp,
            commands::sessions::stop_claude_session,
            commands::sessions::migrate_session,
            commands::sessions::thread_transcript,
            commands::sessions::copilot_session_resumable,
            commands::sessions::find_codex_session,
            commands::sessions::find_opencode_session,
            commands::sessions::find_cursor_session,
            commands::sessions::find_antigravity_session,
            commands::sessions::find_copilot_session,
            commands::sessions::find_grok_session,
            commands::sessions::find_hermes_session,
            commands::sessions::find_pi_session,
            commands::git::git_repo_info,
            commands::git::git_find_repos,
            commands::git::git_branches,
            commands::git::git_switch_branch,
            commands::git::worktree_open,
            commands::git::worktree_warm,
            commands::git::worktree_migrate,
            commands::git::worktree_adopt,
            commands::git::worktree_list,
            commands::git::worktree_claim,
            commands::git::worktree_reserve,
            commands::git::worktree_hold,
            commands::git::worktree_remove,
            commands::git::worktree_sizes,
            commands::git::git_status,
            commands::git::git_changed_paths,
            commands::git::git_log,
            commands::git::git_commit_state,
            commands::git::git_pull_request,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_discard,
            commands::git::git_commit,
            commands::git::git_fetch,
            commands::git::git_push,
            commands::git::git_pull,
            commands::git::git_init,
            commands::git::git_file_versions,
            commands::checkpoint::checkpoint_capture,
            commands::checkpoint::checkpoint_list,
            commands::checkpoint::checkpoint_diff,
            commands::checkpoint::checkpoint_file_versions,
            commands::checkpoint::checkpoint_restore,
            commands::checkpoint::checkpoint_forget,
            commands::app::command_exists,
            commands::app::fastpick_list,
            commands::app::fastpick_version,
            commands::records::records_project_list,
            commands::records::records_project_create,
            commands::records::records_project_archive,
            commands::records::records_project_delete,
            commands::records::records_thread_list,
            commands::records::records_thread_create,
            commands::records::records_thread_update,
            commands::records::records_thread_started,
            commands::records::records_thread_age,
            commands::records::records_thread_pin_order,
            commands::records::records_thread_delete,
            commands::records::records_todo_list,
            commands::records::records_todo_save,
            commands::records::records_todo_delete,
            commands::records::records_settings_get,
            commands::records::records_settings_set,
            commands::records::records_workspace_info,
            commands::records::records_workspace_set_info,
            commands::records::records_search,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let manager = app_handle.state::<PtyManager>();
                manager.kill_all();
            }
        });
}
