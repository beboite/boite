//! The rows the window reads and writes: projects, threads, todos, settings.
//!
//! These are new, and what they replace was not another Rust file. The webview
//! held eight SQL statements of its own and sent them through
//! `tauri-plugin-sql`, so this half of the schema had no Rust reader at all
//! while the server had fifteen hand-written RPC arms over the same tables. The
//! two had already drifted: the server refused to take a client's word for a
//! thread's runtime state, and the raw `INSERT OR REPLACE` here did not.
//!
//! Thin like every other codec in this module. The rows are
//! `boite_core::command::records`; what stays here is naming the command and
//! the one side effect only this host has.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use boite_core::command::Records;
use boite_core::scope::ProjectRoots;
use boite_core::store::Store;

use super::bus::{through, DesktopHost};

/// This app's connection to its own database.
///
/// Attached once and shared. Every earlier caller opened its own, a
/// `Connection::open` plus three pragmas each time, which was affordable for a
/// snapshot somebody asks for and is not for row reads that happen on every
/// boot and every keystroke that renames a thread.
///
/// Lazy on purpose. The schema belongs to `tauri-plugin-sql`, which applies it
/// from the frontend; attaching during `setup` would create the file before the
/// plugin had a chance to migrate it, and `Connection::open` creates rather than
/// fails. First use is after the window has booted, which is after the
/// migrations have run.
#[derive(Default)]
pub struct Rows(Mutex<Option<Arc<Store>>>);

impl Rows {
    /// The shared store, attaching it if this is the first ask.
    ///
    /// A failure is not cached: a config directory that was not there yet is the
    /// most likely reason, and it is one that stops being true.
    pub fn get(&self, app: &AppHandle) -> Result<Arc<Store>, String> {
        let mut held = self
            .0
            .lock()
            .map_err(|_| "the database handle was poisoned by an earlier panic".to_string())?;
        if let Some(store) = held.as_ref() {
            return Ok(store.clone());
        }
        let path = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("app_config_dir: {e}"))?
            .join("boite.db");
        let store = Arc::new(Store::attach(&path)?);
        // First attach is once per app start, and it is before the window has
        // read a single row: exactly where the last run's marks have to be
        // settled, or the boot that reads them would draw a thread that was
        // working when the app closed the same as one that has never run.
        if let Err(e) = store.settle_last_run() {
            eprintln!("[boite/records] settling the last run's thread statuses failed: {e}");
        }
        *held = Some(store.clone());
        Ok(store)
    }
}

/// Puts a record command through the bus with this app's store behind it.
///
/// The transcripts directory travels too, for `search.query` alone: it reads
/// the rows and what the terminals printed in one answer, and a host that
/// declared only half of that would answer half the question.
async fn on_rows(
    app: &AppHandle,
    scope: &ProjectRoots,
    rows: &Rows,
    command: Records,
) -> Result<Value, String> {
    let store = rows.get(app)?;
    let mut host = DesktopHost::new(scope).with_store(store).with_transcripts(app);
    if let Some(runtime) = app.try_state::<Arc<boite_core::telemetry::TelemetryRuntime>>() {
        host = host.with_telemetry(runtime.inner().clone());
    }
    // The pilot runtime travels with a record command too, built on first use
    // rather than only `peek`ed: `records::check_runtime` refuses a chat row
    // whose driver the runtime does not list, and on a fresh app no runtime
    // existed yet, so the first chat thread the window tried to save was
    // refused before its session ever opened. Settling or deleting a chat
    // thread needs the same handle to stop its child. Built once, then cached.
    if let Ok(runtime) = app.state::<super::pilot::PilotRuntime>().get(app) {
        host = host.with_pilot(runtime);
    }
    through(host, command.into()).await
}

/// Reads a wire-shaped call into a command.
///
/// The window and a remote workspace send the same method names with the same
/// parameters, which is the point: `src/lib/backend/tauri/db.ts` and
/// `src/lib/backend/remote/index.ts` stopped being two different vocabularies
/// over one schema.
fn decode(method: &str, params: Value) -> Result<Records, String> {
    match boite_core::command::Command::decode(method, &params)? {
        boite_core::command::Command::Records(r) => Ok(r),
        other => Err(format!("{} is not a record command", other.name())),
    }
}

macro_rules! record_command {
    ($name:ident, $method:literal) => {
        #[tauri::command]
        pub async fn $name(
            app: AppHandle,
            scope: State<'_, ProjectRoots>,
            rows: State<'_, Rows>,
            params: Option<Value>,
        ) -> Result<Value, String> {
            let command = decode($method, params.unwrap_or_else(|| json!({})))?;
            on_rows(&app, scope.inner(), rows.inner(), command).await
        }
    };
}

record_command!(records_project_list, "project.list");
record_command!(records_project_create, "project.create");
record_command!(records_project_archive, "project.archive");
record_command!(records_thread_list, "thread.list");
record_command!(records_thread_create, "thread.create");
record_command!(records_thread_update, "thread.update");
record_command!(records_thread_started, "thread.started");
record_command!(records_thread_settle, "thread.settle");
record_command!(records_todo_list, "todo.list");
record_command!(records_todo_save, "todo.save");
record_command!(records_todo_delete, "todo.delete");
record_command!(records_settings_get, "settings.get");
record_command!(records_settings_set, "settings.set");
record_command!(records_workspace_info, "workspace.info");
record_command!(records_workspace_set_info, "workspace.setInfo");
record_command!(records_search, "search.query");

/// Deletes a project row.
///
/// Not the macro, because the registered roots are built from the project list
/// and a command that changes that list has to say so. Everything a path-taking
/// command is checked against comes from here.
#[tauri::command]
pub async fn records_project_delete(
    app: AppHandle,
    scope: State<'_, ProjectRoots>,
    rows: State<'_, Rows>,
    params: Option<Value>,
) -> Result<Value, String> {
    let command = decode("project.delete", params.unwrap_or_else(|| json!({})))?;
    on_rows(&app, scope.inner(), rows.inner(), command).await
}

/// Deletes a thread row, its key binding, and the key file behind it.
///
/// The file is the part no other host has: the server keeps its keys in its own
/// directory and removes them there. The row is what a public key is looked up
/// on, so the file grants nothing once the row is gone; it is removed anyway
/// rather than left to accumulate one per thread ever opened.
#[tauri::command]
pub async fn records_thread_delete(
    app: AppHandle,
    scope: State<'_, ProjectRoots>,
    rows: State<'_, Rows>,
    params: Option<Value>,
) -> Result<Value, String> {
    let thread_id = params
        .as_ref()
        .and_then(|p| p.get("threadId"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let command = decode("thread.delete", params.unwrap_or_else(|| json!({})))?;
    let answer = on_rows(&app, scope.inner(), rows.inner(), command).await?;
    if let Some(id) = thread_id {
        // Worth removing, not worth failing a delete over: the row is already
        // gone by here, and a key file with no row behind it opens nothing.
        crate::agent_api::forget_thread_key_file(&app, &id);
    }
    Ok(answer)
}
