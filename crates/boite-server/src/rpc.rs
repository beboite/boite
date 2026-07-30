use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use boite_core::pty::PtySpawnArgs;
use boite_core::{editor, explorer, git, project, session, shell};

use crate::events::AppEvent;
use crate::models::{Project, Thread};
use crate::state::AppState;
use crate::store::{ColVal, ThreadCol};

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
            if state.registry.live_count() >= state.max_threads {
                return Err(format!("thread limit reached ({})", state.max_threads));
            }
            let mut thread: Thread = serde_json::from_value(
                params
                    .get("thread")
                    .cloned()
                    .ok_or("missing param: thread")?,
            )
            .map_err(|e| format!("bad thread: {e}"))?;
            let cwd = str_param(&params, "cwd")?;
            state.ensure_registered_path(&cwd)?;
            let cols = u16_param(&params, "cols").unwrap_or(80);
            let rows = u16_param(&params, "rows").unwrap_or(24);
            let mut env = params
                .get("env")
                .and_then(|v| {
                    serde_json::from_value::<std::collections::HashMap<String, String>>(v.clone())
                        .ok()
                })
                .unwrap_or_default();
            // The server spawns the child, so it hands it credentials no client
            // could forge: the thread id stamped here is what scopes the agent
            // to this project's list. Stamped last so a client-supplied env
            // cannot override them.
            if let Some(api) = &state.agent_api {
                env.insert("BOITE_MCP_URL".into(), api.url.clone());
                env.insert("BOITE_TOKEN".into(), api.token.clone());
                env.insert("BOITE_THREAD_ID".into(), thread.id.clone());
            }
            let env = Some(env);
            if thread.created_at == 0 {
                thread.created_at = now_ms();
            }
            thread.status = "running".to_string();
            state.store.save_thread(&thread)?;

            let wrap = params
                .get("wrap")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let spec = PtySpawnArgs {
                cwd,
                cmd: thread.cmd.clone(),
                args: thread.args.clone(),
                cols,
                rows,
                env,
                wrap,
            };
            let pty_id = state.registry.spawn(thread.id.clone(), spec)?;
            thread.pty_id = Some(pty_id);
            let _ = state
                .events
                .send(AppEvent::ThreadCreated(serde_json::to_value(&thread).unwrap()));
            Ok(json!({ "thread": thread }))
        }

        // Persist an idle thread row without opening a PTY. Boite creates a
        // thread the moment its shortcut is clicked; the PTY only opens when the
        // terminal mounts (thread.spawn). status is forced idle: the client is
        // not authoritative for runtime state.
        "thread.create" => {
            let mut thread: Thread = serde_json::from_value(
                params
                    .get("thread")
                    .cloned()
                    .ok_or("missing param: thread")?,
            )
            .map_err(|e| format!("bad thread: {e}"))?;
            if thread.created_at == 0 {
                thread.created_at = now_ms();
            }
            thread.pty_id = None;
            // saveThread doubles as create AND re-save (session-id dedup, label
            // edit). The client is not authoritative for runtime state: on an
            // EXISTING row keep the persisted status/exit_code (a running or
            // closed thread must not be clobbered back to idle), and announce
            // it as an update; only a genuinely new row is idle + created.
            let existed = state.store.thread_status(&thread.id);
            match &existed {
                Some((status, exit_code)) => {
                    thread.status = status.clone();
                    thread.exit_code = *exit_code;
                }
                None => {
                    thread.status = "idle".to_string();
                    thread.exit_code = None;
                }
            }
            state.store.save_thread(&thread)?;
            let value = serde_json::to_value(&thread).unwrap();
            let _ = state.events.send(if existed.is_some() {
                AppEvent::ThreadUpdated(value)
            } else {
                AppEvent::ThreadCreated(value)
            });
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
                    .update_thread_field(&id, ThreadCol::Label, ColVal::Text(label.to_string()))?;
            }
            if let Some(icon) = params.get("iconKey") {
                let v = icon
                    .as_str()
                    .map(|s| ColVal::Text(s.to_string()))
                    .unwrap_or(ColVal::Null);
                state.store.update_thread_field(&id, ThreadCol::IconKey, v)?;
            }
            if let Some(session) = params.get("sessionId") {
                let v = session
                    .as_str()
                    .map(|s| ColVal::Text(s.to_string()))
                    .unwrap_or(ColVal::Null);
                state.store.update_thread_field(&id, ThreadCol::SessionId, v)?;
            }
            if let Some(keep) = params.get("keepAwake").and_then(|v| v.as_bool()) {
                state
                    .store
                    .update_thread_field(&id, ThreadCol::KeepAwake, ColVal::Int(keep as i64))?;
            }
            if let Some(title) = params.get("title") {
                let v = title
                    .as_str()
                    .map(|s| ColVal::Text(s.to_string()))
                    .unwrap_or(ColVal::Null);
                state.store.update_thread_field(&id, ThreadCol::Title, v)?;
            }
            // Emit the full persisted row so clients merge user-owned fields
            // (label/title/iconKey/sessionId/keepAwake). Clients ignore the
            // runtime fields (status/ptyId/exitCode) here; those flow via the
            // thread.status control event and the live overlay.
            if let Ok(Some(updated)) = state.store.load_thread(&id) {
                let _ = state
                    .events
                    .send(AppEvent::ThreadUpdated(serde_json::to_value(&updated).unwrap()));
            }
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
            state.ensure_project_path(&project.cwd)?;
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
            state.refresh_roots()?;
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
            state.ensure_project_path(&path)?;
            let inspection = blocking(move || project::inspect_project_blocking(path)).await??;
            Ok(serde_json::to_value(inspection).unwrap())
        }

        // Where a thread with no project of its own runs. This machine's home,
        // not the connecting device's: the threads live here.
        "project.homeDir" => {
            let home = dirs::home_dir().ok_or("no home directory")?;
            Ok(json!({ "path": home.to_string_lossy() }))
        }

        "project.folderState" => {
            let path = str_param(&params, "path")?;
            state.ensure_project_path(&path)?;
            let folder_state = blocking(move || project::folder_state_blocking(&path)).await?;
            Ok(serde_json::to_value(folder_state).unwrap())
        }

        // The one call that makes a directory outside every registered root,
        // because a project's folder is not a root until the project exists.
        // `ensure_project_path` is the outer boundary a server has and the
        // desktop does not; the same beside-an-existing-project rule is applied
        // on top of it, so an agent reaching this through the MCP endpoint
        // cannot point it at the filesystem at large.
        "project.createFolder" => {
            let path = str_param(&params, "path")?;
            state.ensure_project_path(&path)?;
            let mut allowed = state.roots.new_project_parents();
            if let Some(home) = dirs::home_dir() {
                allowed.push(home.to_string_lossy().to_string());
            }
            if let Some(workspace) = &state.workspace_dir {
                allowed.push(workspace.to_string_lossy().to_string());
            }
            if !project::may_create_project_at(&path, &allowed) {
                return Err(
                    "a new project has to go under the home folder or beside a project that \
                     already exists"
                        .into(),
                );
            }
            if project::folder_state_blocking(&path) == project::FolderState::Occupied {
                return Err("there is already something in that folder".into());
            }
            std::fs::create_dir_all(&path).map_err(|e| format!("cannot create the folder: {e}"))?;
            Ok(json!({ "ok": true }))
        }

        // An agent request reaches every connected device; this decides which
        // one carries it out. True for exactly one caller per id — two devices
        // running the same move would kill one PTY twice and leave a second
        // worktree behind.
        "agent.claimRequest" => {
            let id = str_param(&params, "requestId")?;
            Ok(json!({ "claimed": state.claim_agent_request(&id) }))
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

        "todo.list" => {
            let todos = state.store.load_todos()?;
            Ok(json!({ "todos": todos }))
        }

        "todo.save" => {
            let raw = params.get("todo").cloned().ok_or("missing todo")?;
            let todo: crate::models::Todo =
                serde_json::from_value(raw).map_err(|e| format!("bad todo: {e}"))?;
            state.store.save_todo(&todo)?;
            let _ = state.events.send(AppEvent::TodosChanged);
            Ok(json!({ "ok": true }))
        }

        "todo.delete" => {
            let id = params
                .get("todoId")
                .and_then(|v| v.as_str())
                .ok_or("missing todoId")?;
            state.store.delete_todo(id)?;
            let _ = state.events.send(AppEvent::TodosChanged);
            Ok(json!({ "ok": true }))
        }

        // Cosmetic workspace identity, server-synced so any connected device can
        // rename/recolor a boite and the rest see it live.
        "workspace.info" => {
            let meta = state.store.load_workspace_meta()?;
            Ok(json!({
                "name": meta.get("name").and_then(|v| v.as_str()),
                "color": meta.get("color").and_then(|v| v.as_str()),
            }))
        }

        "workspace.setInfo" => {
            let mut meta = state.store.load_workspace_meta()?;
            let obj = meta
                .as_object_mut()
                .ok_or("corrupt workspace meta")?;
            if let Some(name) = params.get("name") {
                match name.as_str().map(|s| s.trim()) {
                    Some(s) if !s.is_empty() => {
                        obj.insert("name".into(), json!(s.chars().take(64).collect::<String>()));
                    }
                    // Explicit null or blank clears the override (falls back to host).
                    _ => {
                        obj.remove("name");
                    }
                }
            }
            if let Some(color) = params.get("color") {
                match color.as_str() {
                    // Reject anything that is not a hex color: the value lands in
                    // a CSS custom property on every client.
                    Some(s) if valid_hex_color(s) => {
                        obj.insert("color".into(), json!(s));
                    }
                    _ if color.is_null() => {
                        obj.remove("color");
                    }
                    _ => {}
                }
            }
            state.store.save_workspace_meta(&meta)?;
            let name = meta.get("name").and_then(|v| v.as_str()).map(str::to_string);
            let color = meta.get("color").and_then(|v| v.as_str()).map(str::to_string);
            let _ = state.events.send(AppEvent::WorkspaceInfo {
                name: name.clone(),
                color: color.clone(),
            });
            Ok(json!({ "name": name, "color": color }))
        }

        "shell.default" => {
            let s = blocking(shell::default_shell_blocking).await?;
            Ok(json!({ "shell": s }))
        }

        "shell.available" => {
            let shells = blocking(shell::available_shells_blocking).await?;
            Ok(json!({ "shells": shells }))
        }

        // The setup wizard asks whether an agent is installed. The agents run
        // here, so this server's PATH is the one that decides, not the PATH of
        // whatever device is driving the UI.
        "shell.commandExists" => {
            let cmd = str_param(&params, "cmd")?;
            let found = blocking(move || shell::command_exists(&cmd)).await?;
            Ok(json!({ "found": found }))
        }

        // fastpick lives on the machine that runs the agents, which is this one. That is
        // what keeps its key files here: the device drawing the menu gets the choices, and
        // the credential is read at spawn time on this side and never travels.
        //
        // The payload is fastpick's own JSON, passed through as a string rather than
        // reparsed. Its schema is fastpick's to grow, and the client types what it reads.
        "fastpick.list" => {
            let provider = params
                .get("provider")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let refresh = params
                .get("refresh")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let json =
                blocking(move || boite_core::fastpick::list_blocking(provider, refresh)).await??;
            Ok(json!({ "json": json }))
        }

        // Null version means no fastpick here, which is a state the settings panel draws
        // rather than an error it reports.
        "fastpick.version" => {
            let version = blocking(boite_core::fastpick::version_blocking).await?;
            Ok(json!({ "version": version }))
        }

        // Warms the server's own function/alias list. The client cannot answer
        // this for a remote boite: the profile that matters is the server's.
        "shell.warm" => {
            let id = str_param(&params, "shellId")?;
            state.registry.warm_shell_names(&id);
            Ok(json!({ "ok": true }))
        }

        // The agents run here, so this is where the registry of open sessions
        // is. Clients ask before replaying a captured id: claude refuses
        // `--resume` for anything it still has open.
        "session.liveClaude" => {
            let sessions = boite_core::session::live_claude_sessions();
            Ok(json!({ "sessions": sessions }))
        }

        // The transcripts are here, not on the phone reading the dashboard.
        //
        // A directory outside the trust boundary is dropped rather than
        // refused: the list carries the project's worktrees, which live under
        // the server's own base and not under any project root, and one of
        // those must not take the whole card down with it. Nothing here opens
        // the paths — they are compared as strings against what the agents
        // recorded — so a dropped one costs coverage, never safety.
        "session.usage" => {
            let cwds: Vec<String> = params
                .get("cwds")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let days = params.get("days").and_then(|v| v.as_u64()).unwrap_or(365) as u32;
            let report =
                blocking(move || boite_core::usage::collect_usage_blocking(cwds, days)).await?;
            Ok(serde_json::to_value(report).unwrap())
        }

        "session.stopClaude" => {
            let id = str_param(&params, "sessionId")?;
            let stopped = blocking(move || boite_core::session::stop_claude_session(&id)).await?;
            Ok(json!({ "stopped": stopped }))
        }

        // Same reason, different refusal: copilot turns down an id whose
        // session was opened and never used.
        "session.copilotResumable" => {
            let id = str_param(&params, "sessionId")?;
            let resumable =
                blocking(move || boite_core::session::copilot_session_resumable(&id)).await?;
            Ok(json!({ "resumable": resumable }))
        }

        // A thread that changed project changed the folder claude searches for
        // its transcripts, so the file has to follow it here — the agents and
        // their session stores both live on this machine.
        "session.migrate" => {
            let kind = str_param(&params, "kind")?;
            let id = str_param(&params, "sessionId")?;
            let from = str_param(&params, "fromCwd")?;
            let to = str_param(&params, "toCwd")?;
            let migrated = blocking(move || {
                boite_core::session::migrate_session_blocking(&kind, &id, &from, &to)
            })
            .await??;
            Ok(json!({ "migrated": migrated }))
        }

        "session.find" => {
            let kind = str_param(&params, "kind")?;
            let cwd = str_param(&params, "cwd")?;
            let after = params
                .get("afterUnixMs")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let exclude = session::build_exclude(Some(str_list(&params, "excludeIds")));
            // Which process the caller's PTY is running, so the session it
            // holds open is not mistaken for someone else's live one.
            let own_pid = params
                .get("ptyId")
                .and_then(|v| v.as_str())
                .and_then(|id| state.registry.pty_manager().child_pid(id));
            let result = blocking(move || -> Value {
                match kind.as_str() {
                    "claude" => session::find_claude_session_blocking(cwd, after, &exclude, own_pid)
                        .map(|h| json!({ "id": h.id, "modifiedMs": h.modified_ms }))
                        .unwrap_or(Value::Null),
                    "codex" => session::find_codex_session_blocking(cwd, after, &exclude)
                        .map(|h| json!({ "id": h.id, "modifiedMs": h.modified_ms, "title": h.title }))
                        .unwrap_or(Value::Null),
                    "opencode" => {
                        hit_or_null(session::find_opencode_session_blocking(cwd, after, &exclude))
                    }
                    "cursor" => {
                        hit_or_null(session::find_cursor_session_blocking(cwd, after, &exclude))
                    }
                    "antigravity" => hit_or_null(session::find_antigravity_session_blocking(
                        cwd, after, &exclude,
                    )),
                    "copilot" => {
                        hit_or_null(session::find_copilot_session_blocking(cwd, after, &exclude))
                    }
                    "grok" => {
                        hit_or_null(session::find_grok_session_blocking(cwd, after, &exclude))
                    }
                    "hermes" => {
                        hit_or_null(session::find_hermes_session_blocking(cwd, after, &exclude))
                    }
                    _ => Value::Null,
                }
            })
            .await?;
            Ok(json!({ "session": result }))
        }

        // Base dir for the web folder picker (Docker repos mount). Browsing
        // happens via fs.readDir, which is allowed because workspace_dir is a
        // registered root (state.refresh_roots).
        "fs.workspaceRoot" => Ok(json!({
            "root": state.workspace_dir.as_ref().map(|p| p.to_string_lossy().to_string())
        })),

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

        "notify.test" => {
            let title = params
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Boite")
                .to_string();
            let body = params
                .get("body")
                .and_then(|v| v.as_str())
                .unwrap_or("Test notification")
                .to_string();
            state.notifier.send(&title, &body, "test").await;
            Ok(json!({ "ok": true, "enabled": state.notifier.enabled() }))
        }

        // Web Push: the PWA fetches the VAPID public key, subscribes its browser
        // push endpoint, and registers it server-side. Subscriptions are global
        // (every authenticated client shares them, like settings).
        "push.publicKey" => Ok(json!({ "key": state.push.public_key() })),

        "push.subscribe" => {
            let endpoint = str_param(&params, "endpoint")?;
            let keys = params.get("keys").ok_or("missing param: keys")?;
            let p256dh = keys
                .get("p256dh")
                .and_then(|v| v.as_str())
                .ok_or("missing param: keys.p256dh")?;
            let auth = keys
                .get("auth")
                .and_then(|v| v.as_str())
                .ok_or("missing param: keys.auth")?;
            state
                .store
                .add_push_subscription(&endpoint, p256dh, auth, now_ms())?;
            Ok(json!({ "ok": true }))
        }

        "push.unsubscribe" => {
            let endpoint = str_param(&params, "endpoint")?;
            state.store.delete_push_subscription(&endpoint)?;
            Ok(json!({ "ok": true }))
        }

        m if m.starts_with("git.") => dispatch_git(state, m, params).await,

        m if m.starts_with("worktree.") => dispatch_worktree(state, m, params).await,

        other => Err(format!("unknown method: {other}")),
    }
}

/// Worktree lifecycle. Every path here is checked against the trust boundary
/// the same way the git methods are; `worktree.open` builds its own path under
/// the server's worktree base rather than accepting one from the client.
async fn dispatch_worktree(
    state: &AppState,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    match method {
        "worktree.open" => {
            let repo = str_param(&params, "repo")?;
            state.roots.ensure_allowed(&repo)?;
            let thread_id = str_param(&params, "threadId")?;
            let base = state.worktree_base();
            std::fs::create_dir_all(&base).map_err(|e| format!("worktree base: {e}"))?;
            let path = git::scoped_dir_for(&base, &thread_id)
                .to_string_lossy()
                .to_string();
            // `path` is null when the repository is not one to open a worktree
            // in: no repo, or a dirty checkout the thread has to start in.
            let r = blocking(move || git::open_worktree_if_eligible_blocking(&repo, &path)).await??;
            Ok(json!({ "path": r }))
        }
        "worktree.list" => {
            let repo = str_param(&params, "repo")?;
            state.roots.ensure_allowed(&repo)?;
            let r = blocking(move || git::list_worktrees_blocking(&repo)).await??;
            Ok(json!({ "worktrees": r }))
        }
        "worktree.claim" => {
            let path = str_param(&params, "path")?;
            state.roots.ensure_allowed(&path)?;
            let name = str_param(&params, "name")?;
            blocking(move || git::claim_worktree_branch_blocking(&path, &name)).await??;
            Ok(json!({ "ok": true }))
        }
        "worktree.reserve" => {
            let path = str_param(&params, "path")?;
            state.roots.ensure_allowed(&path)?;
            let name = str_param(&params, "name")?;
            blocking(move || git::reserve_worktree_branch_blocking(&path, &name)).await??;
            Ok(json!({ "ok": true }))
        }
        "worktree.hold" => {
            let path = str_param(&params, "path")?;
            state.roots.ensure_allowed(&path)?;
            let r = blocking(move || git::worktree_hold_blocking(&path)).await??;
            Ok(serde_json::to_value(r).unwrap())
        }
        "worktree.remove" => {
            let repo = str_param(&params, "repo")?;
            let path = str_param(&params, "path")?;
            state.roots.ensure_allowed(&repo)?;
            state.roots.ensure_allowed(&path)?;
            let force = params
                .get("force")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            blocking(move || git::remove_worktree_blocking(&repo, &path, force)).await??;
            Ok(json!({ "ok": true }))
        }
        other => Err(format!("unknown method: {other}")),
    }
}

/// A hit from one of the detectors that answer with an id and an activity
/// timestamp. The timestamp is omitted rather than zeroed when the store had
/// none to give: the client skips attribution on a missing one, and would have
/// refused the session outright on a zero.
fn hit_or_null(opt: Option<session::SessionHit>) -> Value {
    opt.map(|h| json!({ "id": h.id, "modifiedMs": h.modified_ms }))
        .unwrap_or(Value::Null)
}

fn valid_hex_color(s: &str) -> bool {
    let Some(hex) = s.strip_prefix('#') else {
        return false;
    };
    (hex.len() == 3 || hex.len() == 6) && hex.bytes().all(|b| b.is_ascii_hexdigit())
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
        "git.findRepos" => {
            let r = blocking(move || git::find_repos_blocking(&p, 3)).await??;
            Ok(json!({ "repos": r }))
        }
        "git.branches" => {
            let r = blocking(move || git::branches_blocking(&p)).await??;
            Ok(json!({ "branches": r }))
        }
        "git.switchBranch" => {
            let name = str_param(&params, "name")?;
            let create = params
                .get("create")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let stash = params
                .get("stash")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let r =
                blocking(move || git::switch_branch_blocking(&p, &name, create, stash)).await??;
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
        // The repository is here, so this is where a claimed sha can be read
        // back and where `gh` would be reachable.
        "git.commitState" => {
            let sha = str_param(&params, "sha")?;
            let r = blocking(move || git::commit_state_blocking(&p, &sha)).await?;
            Ok(json!({ "state": r }))
        }
        "git.pullRequest" => {
            let branch = str_param(&params, "branch")?;
            let r = blocking(move || git::pull_request_for_branch_blocking(&p, &branch)).await?;
            Ok(json!({ "lookup": r }))
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
