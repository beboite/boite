mod commands;
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

fn show_main_window(handle: &tauri::AppHandle) {
    if let Some(win) = handle.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
    ];

    tauri::Builder::default()
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
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:boite.db", migrations)
                .build(),
        )
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
            commands::find_codex_session,
            commands::find_opencode_session,
            commands::find_cursor_session,
            commands::find_antigravity_session,
            commands::find_copilot_session,
            commands::find_grok_session,
            commands::find_hermes_session,
            commands::git_repo_info,
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
