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

fn show_main_window(handle: &tauri::AppHandle) {
    if let Some(win) = handle.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before the first which() or PTY: launched from Finder we start with
    // launchd's bare PATH, which hides Homebrew and every agent CLI.
    boite_core::env::hydrate_login_path();

    let migrations = vec![
        Migration {
            version: 1,
            description: "create_projects",
            sql: "CREATE TABLE IF NOT EXISTS projects (\
                id TEXT PRIMARY KEY,\
                name TEXT NOT NULL,\
                cwd TEXT NOT NULL,\
                default_cmd TEXT NOT NULL,\
                default_args TEXT NOT NULL,\
                created_at INTEGER NOT NULL\
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add_project_icon",
            sql: "ALTER TABLE projects ADD COLUMN icon TEXT;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "create_settings",
            sql: "CREATE TABLE IF NOT EXISTS settings (\
                key TEXT PRIMARY KEY,\
                value TEXT NOT NULL\
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "create_threads",
            sql: "CREATE TABLE IF NOT EXISTS threads (\
                id TEXT PRIMARY KEY,\
                project_id TEXT NOT NULL,\
                label TEXT NOT NULL,\
                title TEXT,\
                cmd TEXT NOT NULL,\
                args TEXT NOT NULL,\
                exit_code INTEGER,\
                created_at INTEGER NOT NULL\
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add_thread_session_and_icon",
            sql: "ALTER TABLE threads ADD COLUMN session_id TEXT;\
                  ALTER TABLE threads ADD COLUMN icon_key TEXT;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "add_project_archived",
            sql: "ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "add_thread_status_and_autoslept",
            sql: "ALTER TABLE threads ADD COLUMN status TEXT;\
                  ALTER TABLE threads ADD COLUMN auto_slept INTEGER NOT NULL DEFAULT 0;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "add_thread_keep_awake",
            sql: "ALTER TABLE threads ADD COLUMN keep_awake INTEGER NOT NULL DEFAULT 0;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "add_project_git_root",
            sql: "ALTER TABLE projects ADD COLUMN git_root TEXT;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "add_thread_icon_color",
            sql: "ALTER TABLE threads ADD COLUMN icon_color TEXT;",
            kind: MigrationKind::Up,
        },
    ];

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
        .setup(|app| {
            let setup_handle = app.handle().clone();
            if let Err(e) = logging::begin_log_session(&setup_handle) {
                eprintln!("[boite/logging] begin_log_session failed: {e}");
            }
            logging::install_panic_hook(setup_handle.clone());
            fullscreen::watch(&setup_handle);
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
            commands::pty_spawn,
            commands::pty_open,
            commands::pty_detach,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::finish_boot,
            commands::log_app_event,
            commands::read_app_log,
            commands::clear_app_log,
            commands::log_file_path,
            commands::register_project_roots,
            commands::inspect_project,
            commands::read_dir,
            commands::explorer_search,
            commands::read_text_file,
            commands::write_text_file,
            commands::default_shell,
            commands::available_shells,
            commands::find_claude_session,
            commands::live_claude_sessions,
            commands::stop_claude_session,
            commands::find_codex_session,
            commands::find_opencode_session,
            commands::find_cursor_session,
            commands::find_antigravity_session,
            commands::find_copilot_session,
            commands::find_grok_session,
            commands::find_hermes_session,
            commands::git_repo_info,
            commands::git_find_repos,
            commands::git_status,
            commands::git_changed_paths,
            commands::git_log,
            commands::git_stage,
            commands::git_unstage,
            commands::git_discard,
            commands::git_commit,
            commands::git_fetch,
            commands::git_push,
            commands::git_pull,
            commands::git_init,
            commands::git_file_versions,
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
