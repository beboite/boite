use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use boite_core::pty::PtySpawnArgs;
use boite_core::{editor, explorer, git, project, session, shell};

use crate::events::AppEvent;
use crate::models::{Project, Thread};
use crate::state::AppState;
use crate::store::ColVal;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn str_param(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing param: {key}"))
}

fn u16_param(params: &Value, key: &str) -> Result<u16, String> {
    params
        .get(key)
        .and_then(|v| v.as_u64())
        .map(|n| n as u16)
        .ok_or_else(|| format!("missing param: {key}"))
}

fn str_list(params: &Value, key: &str) -> Vec<String> {
    params
        .get(key)
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

async fn blocking<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("task join failed: {e}"))
}

// Dispatch every non-streaming method. thread.attach / thread.detach and
// binary input frames are handled in ws.rs (they need the socket writer).
pub async fn dispatch(state: &AppState, method: &str, params: Value) -> Result<Value, String> {
    match method {
        "hello" => Ok(json!({ "ok": true, "protocol": 1 })),

        "thread.list" => {
            let mut threads = state.store.load_threads()?;
            let live = state.registry.live_snapshot();
            for t in &mut threads {
                if let Some((pty_id, status, title)) = live.get(&t.id) {
                    t.pty_id = Some(pty_id.clone());
                    t.status = status.clone();
                    if title.is_some() {
                        t.title = title.clone();
                    }
                }
            }
            Ok(json!({ "threads": threads }))
        }

        "thread.spawn" => {
            let mut thread: Thread = serde_json::from_value(
                params
                    .get("thread")
                    .cloned()
                    .ok_or("missing param: thread")?,
            )
            .map_err(|e| format!("bad thread: {e}"))?;
            let cwd = str_param(&params, "cwd")?;
            let cols = u16_param(&params, "cols").unwrap_or(80);
            let rows = u16_param(&params, "rows").unwrap_or(24);
            let env = params.get("env").and_then(|v| {
                serde_json::from_value::<std::collections::HashMap<String, String>>(v.clone()).ok()
            });
            if thread.created_at == 0 {
                thread.created_at = now_ms();
            }
            thread.status = "running".to_string();
            state.store.save_thread(&thread)?;

            let spec = PtySpawnArgs {
                cwd,
                cmd: thread.cmd.clone(),
                args: thread.args.clone(),
                cols,
                rows,
                env,
            };
            let pty_id = state.registry.spawn(thread.id.clone(), spec)?;
            thread.pty_id = Some(pty_id);
            let _ = state
                .events
                .send(AppEvent::ThreadCreated(serde_json::to_value(&thread).unwrap()));
            Ok(json!({ "thread": thread }))
        }

        "thread.resize" => {
            let id = str_param(&params, "threadId")?;
            let cols = u16_param(&params, "cols")?;
            let rows = u16_param(&params, "rows")?;
            state.registry.resize(&id, cols, rows)?;
            Ok(json!({ "ok": true }))
        }

        "thread.kill" => {
            let id = str_param(&params, "threadId")?;
            let wait = params.get("wait").and_then(|v| v.as_bool()).unwrap_or(true);
            let registry = state.registry.clone();
            let id2 = id.clone();
            blocking(move || registry.kill(&id2, wait)).await??;
            Ok(json!({ "ok": true }))
        }

        "thread.update" => {
            let id = str_param(&params, "threadId")?;
            if let Some(label) = params.get("label").and_then(|v| v.as_str()) {
                state
                    .store
                    .update_thread_field(&id, "label", ColVal::Text(label.to_string()))?;
            }
            if let Some(icon) = params.get("iconKey") {
                let v = icon
                    .as_str()
                    .map(|s| ColVal::Text(s.to_string()))
                    .unwrap_or(ColVal::Null);
                state.store.update_thread_field(&id, "icon_key", v)?;
            }
            if let Some(session) = params.get("sessionId") {
                let v = session
                    .as_str()
                    .map(|s| ColVal::Text(s.to_string()))
                    .unwrap_or(ColVal::Null);
                state.store.update_thread_field(&id, "session_id", v)?;
            }
            if let Some(keep) = params.get("keepAwake").and_then(|v| v.as_bool()) {
                state
                    .store
                    .update_thread_field(&id, "keep_awake", ColVal::Int(keep as i64))?;
            }
            if let Some(title) = params.get("title") {
                let v = title
                    .as_str()
                    .map(|s| ColVal::Text(s.to_string()))
                    .unwrap_or(ColVal::Null);
                state.store.update_thread_field(&id, "title", v)?;
            }
            let _ = state.events.send(AppEvent::ThreadUpdated(json!({ "id": id })));
            Ok(json!({ "ok": true }))
        }

        "thread.delete" => {
            let id = str_param(&params, "threadId")?;
            let registry = state.registry.clone();
            let id2 = id.clone();
            let _ = blocking(move || registry.kill(&id2, false)).await?;
            state.store.delete_thread(&id)?;
            let _ = state.events.send(AppEvent::ThreadDeleted {
                thread_id: id.clone(),
            });
            Ok(json!({ "ok": true }))
        }

        "project.list" => {
            let projects = state.store.load_projects()?;
            Ok(json!({ "projects": projects }))
        }

        "project.create" => {
            let project: Project = serde_json::from_value(
                params
                    .get("project")
                    .cloned()
                    .ok_or("missing param: project")?,
            )
            .map_err(|e| format!("bad project: {e}"))?;
            state.store.save_project(&project, now_ms())?;
            state.refresh_roots()?;
            let _ = state.events.send(AppEvent::ProjectChanged);
            Ok(json!({ "project": project }))
        }

        "project.archive" => {
            let id = str_param(&params, "id")?;
            let archived = params
                .get("archived")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            state.store.set_project_archived(&id, archived)?;
            let _ = state.events.send(AppEvent::ProjectChanged);
            Ok(json!({ "ok": true }))
        }

        "project.delete" => {
            let id = str_param(&params, "id")?;
            state.store.delete_project(&id)?;
            state.refresh_roots()?;
            let _ = state.events.send(AppEvent::ProjectChanged);
            Ok(json!({ "ok": true }))
        }

        "project.inspect" => {
            let path = str_param(&params, "path")?;
            let inspection = blocking(move || project::inspect_project_blocking(path)).await??;
            Ok(serde_json::to_value(inspection).unwrap())
        }

        "settings.get" => {
            let value = state.store.load_settings()?;
            Ok(json!({ "settings": value }))
        }

        "settings.set" => {
            let value = params.get("settings").cloned().ok_or("missing settings")?;
            state.store.save_settings(&value)?;
            let _ = state.events.send(AppEvent::SettingsChanged);
            Ok(json!({ "ok": true }))
        }

        "shell.default" => {
            let s = blocking(shell::default_shell_blocking).await?;
            Ok(json!({ "shell": s }))
        }

        "shell.available" => {
            let shells = blocking(shell::available_shells_blocking).await?;
            Ok(json!({ "shells": shells }))
        }

        "session.find" => {
            let kind = str_param(&params, "kind")?;
            let cwd = str_param(&params, "cwd")?;
            let after = params
                .get("afterUnixMs")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let exclude = session::build_exclude(Some(str_list(&params, "excludeIds")));
            let result = blocking(move || -> Value {
                match kind.as_str() {
                    "claude" => session::find_claude_session_blocking(cwd, after, &exclude)
                        .map(|h| json!({ "id": h.id, "modifiedMs": h.modified_ms }))
                        .unwrap_or(Value::Null),
                    "codex" => id_or_null(session::find_codex_session_blocking(cwd, after, &exclude)),
                    "opencode" => {
                        id_or_null(session::find_opencode_session_blocking(cwd, after, &exclude))
                    }
                    "cursor" => {
                        id_or_null(session::find_cursor_session_blocking(cwd, after, &exclude))
                    }
                    "antigravity" => id_or_null(session::find_antigravity_session_blocking(
                        cwd, after, &exclude,
                    )),
                    "copilot" => {
                        id_or_null(session::find_copilot_session_blocking(cwd, after, &exclude))
                    }
                    _ => Value::Null,
                }
            })
            .await?;
            Ok(json!({ "session": result }))
        }

        "fs.readDir" => {
            let path = str_param(&params, "path")?;
            state.roots.ensure_allowed(&path)?;
            let entries = blocking(move || explorer::read_dir_blocking(path)).await??;
            Ok(json!({ "entries": entries }))
        }

        "fs.search" => {
            let path = str_param(&params, "path")?;
            let query = str_param(&params, "query")?;
            let limit = params.get("limit").and_then(|v| v.as_u64()).unwrap_or(200) as u32;
            state.roots.ensure_allowed(&path)?;
            let hits = blocking(move || explorer::search_blocking(&path, &query, limit)).await??;
            Ok(json!({ "hits": hits }))
        }

        "file.read" => {
            let path = str_param(&params, "path")?;
            state.roots.ensure_allowed(&path)?;
            let file = blocking(move || editor::read_blocking(&path)).await??;
            Ok(serde_json::to_value(file).unwrap())
        }

        "file.write" => {
            let path = str_param(&params, "path")?;
            let content = str_param(&params, "content")?;
            state.roots.ensure_allowed_for_write(&path)?;
            let written = blocking(move || editor::write_blocking(&path, &content)).await??;
            Ok(json!({ "bytes": written }))
        }

        m if m.starts_with("git.") => dispatch_git(state, m, params).await,

        other => Err(format!("unknown method: {other}")),
    }
}

fn id_or_null(opt: Option<String>) -> Value {
    opt.map(Value::String).unwrap_or(Value::Null)
}

async fn dispatch_git(state: &AppState, method: &str, params: Value) -> Result<Value, String> {
    let path = str_param(&params, "path")?;
    state.roots.ensure_allowed(&path)?;
    let p = path.clone();
    match method {
        "git.repoInfo" => {
            let r = blocking(move || git::repo_info_blocking(&p)).await??;
            Ok(serde_json::to_value(r).unwrap())
        }
        "git.status" => {
            let r = blocking(move || git::status_blocking(&p)).await??;
            Ok(json!({ "entries": r }))
        }
        "git.changedPaths" => {
            let r = blocking(move || git::changed_paths_blocking(&p)).await??;
            Ok(json!({ "paths": r }))
        }
        "git.log" => {
            let limit = params.get("limit").and_then(|v| v.as_u64()).unwrap_or(100) as u32;
            let skip = params.get("skip").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let r = blocking(move || git::log_blocking(&p, limit, skip)).await??;
            Ok(json!({ "commits": r }))
        }
        "git.stage" => {
            let files = str_list(&params, "files");
            blocking(move || git::run_files(&p, "add", &files, true)).await??;
            Ok(json!({ "ok": true }))
        }
        "git.unstage" => {
            let files = str_list(&params, "files");
            blocking(move || git::unstage_blocking(&p, files)).await??;
            Ok(json!({ "ok": true }))
        }
        "git.discard" => {
            let files = str_list(&params, "files");
            let untracked = str_list(&params, "untracked");
            blocking(move || git::discard_blocking(&p, files, untracked)).await??;
            Ok(json!({ "ok": true }))
        }
        "git.commit" => {
            let message = str_param(&params, "message")?;
            let sha = blocking(move || git::commit_blocking(&p, &message)).await??;
            Ok(json!({ "sha": sha }))
        }
        "git.fetch" => {
            blocking(move || git::fetch_blocking(&p)).await??;
            Ok(json!({ "ok": true }))
        }
        "git.push" => {
            blocking(move || git::push_blocking(&p)).await??;
            Ok(json!({ "ok": true }))
        }
        "git.pull" => {
            blocking(move || git::pull_blocking(&p)).await??;
            Ok(json!({ "ok": true }))
        }
        "git.init" => {
            blocking(move || git::init_blocking(&p)).await??;
            Ok(json!({ "ok": true }))
        }
        "git.fileVersions" => {
            let file = str_param(&params, "file")?;
            let head_file = params
                .get("headFile")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let r = blocking(move || {
                git::file_versions_blocking(&p, &file, head_file.as_deref())
            })
            .await??;
            Ok(serde_json::to_value(r).unwrap())
        }
        other => Err(format!("unknown git method: {other}")),
    }
}
