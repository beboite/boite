mod commands;
mod git;
mod logging;
mod project;
mod pty;
mod session;
mod shell;

use std::sync::atomic::{AtomicBool, Ordering};

use pty::PtyManager;
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
    ];

    tauri::Builder::default()
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
        .manage(BootState::default())
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

            // Failsafe: if frontend fails to call finish_boot within 5s, show anyway.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(5000));
                let state = handle.state::<BootState>();
                if !state.is_completed() {
                    let _ = logging::append_app_log(
                        &handle,
                        "warn",
                        "backend.boot-failsafe",
                        "Failsafe triggered after 5000ms; forcing main window visibility",
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
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::finish_boot,
            commands::log_app_event,
            commands::read_app_log,
            commands::clear_app_log,
            commands::log_file_path,
            project::inspect_project,
            shell::default_shell,
            shell::available_shells,
            session::find_claude_session,
            session::find_codex_session,
            session::find_opencode_session,
            session::find_cursor_session,
            session::find_gemini_session,
            session::find_copilot_session,
            git::git_repo_info,
            git::git_status,
            git::git_log,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_fetch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
