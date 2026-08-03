use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use boite_core::command::{self, Command};
use boite_core::pty::PtySpawnArgs;

use crate::events::AppEvent;
use boite_core::model::{Project, Thread};
use crate::state::AppState;
use boite_core::store::{ColVal, ThreadCol};

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
                // The path, never the token. See `AgentApi::token_path`.
                env.insert(
                    "BOITE_TOKEN_FILE".into(),
                    api.token_path.to_string_lossy().into_owned(),
                );
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

        // Where a thread with no project of its own runs. This machine's home,
        // not the connecting device's: the threads live here.
        "project.homeDir" => {
            let home = dirs::home_dir().ok_or("no home directory")?;
            Ok(json!({ "path": home.to_string_lossy() }))
        }

        // An agent request reaches every connected device; this decides which
        // one carries it out. True for exactly one caller per id — two devices
        // running the same move would kill one PTY twice and leave a second
        // worktree behind.
        // Everything at once, for whoever has to work out why something is
        // wrong. Assembled in `boite_core::snapshot` so this side and the
        // desktop answer the same question the same way; what is added here is
        // the registry's own view of which PTYs still have a process.
        "system.snapshot" => {
            let manager = state.registry.pty_manager();
            let live: Vec<boite_core::snapshot::LivePty> = state
                .registry
                .live_snapshot()
                .into_iter()
                .map(|(thread_id, (pty_id, _, _))| boite_core::snapshot::LivePty {
                    child_pid: manager.child_pid(&pty_id),
                    thread_id,
                    pty_id,
                })
                .collect();
            let store = state.store.clone();
            let roots = state.roots.clone();
            let taken = blocking(move || {
                boite_core::snapshot::take("server", &store, &roots, live)
            })
            .await?;
            Ok(serde_json::to_value(taken).unwrap())
        }

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
            let todo: boite_core::model::Todo =
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

        // Which OS the threads run on. The device drawing the UI cannot work
        // this out for itself: a browser has no way to ask, and a Windows
        // desktop driving this boite would answer for its own machine and then
        // pick a Windows shell out of a Linux list.
        "system.platform" => {
            let os = if cfg!(target_os = "windows") {
                "windows"
            } else if cfg!(target_os = "macos") {
                "macos"
            } else if cfg!(target_os = "linux") {
                "linux"
            } else {
                "unknown"
            };
            Ok(json!({ "platform": os }))
        }

        // Warms the server's own function/alias list. The client cannot answer
        // this for a remote boite: the profile that matters is the server's.
        "shell.warm" => {
            let id = str_param(&params, "shellId")?;
            state.registry.warm_shell_names(&id);
            Ok(json!({ "ok": true }))
        }

        // Base dir for the web folder picker (Docker repos mount). Browsing
        // happens via fs.readDir, which is allowed because workspace_dir is a
        // registered root (state.refresh_roots).
        "fs.workspaceRoot" => Ok(json!({
            "root": state.workspace_dir.as_ref().map(|p| p.to_string_lossy().to_string())
        })),

        // Fires one notification down every configured path so a remote user can
        // tell "nothing happened" apart from "nothing was configured". Its only
        // caller is scripts/server-smoke.mjs: no client calls it, because the
        // frontend has no method for it (a settings button would need one added
        // to the remote backend's capability surface first). Kept because the
        // smoke script is how a fresh deployment gets checked.
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
            // The server POSTs to this on its own, unprompted, on every thread
            // transition. Unchecked, registering one is how a client borrows the
            // server's reach into its own network.
            crate::push::acceptable_endpoint(&endpoint)?;
            let keys = params.get("keys").ok_or("missing param: keys")?;
            let p256dh = keys
                .get("p256dh")
                .and_then(|v| v.as_str())
                .ok_or("missing param: keys.p256dh")?;
            let auth = keys
                .get("auth")
                .and_then(|v| v.as_str())
                .ok_or("missing param: keys.auth")?;
            // Re-registering an endpoint already stored is the ordinary case and
            // replaces the row, so only a new one counts against the cap.
            let full = state
                .store
                .list_push_subscriptions()
                .map(|subs| {
                    subs.len() >= crate::push::MAX_PUSH_SUBSCRIPTIONS
                        && !subs.iter().any(|s| s.endpoint == endpoint)
                })
                .unwrap_or(false);
            if full {
                return Err("this workspace already holds as many push endpoints as it takes".into());
            }
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

        // Every domain the desktop serves too — git, worktrees, the
        // filesystem, the editor, the folders a project lives in — is one bus
        // in `boite_core::command` rather than a list of arms here. What is
        // left on this side is the decoding and the envelope this protocol
        // wraps an answer in.
        m if command::handles(m) => {
            let command = Command::decode(m, &params)?;
            let wire = command.wire();
            let ready = command.prepare(&state.command_host())?;
            Ok(wire.wrap(blocking(move || ready.run()).await??))
        }

        other => Err(format!("unknown method: {other}")),
    }
}

fn valid_hex_color(s: &str) -> bool {
    let Some(hex) = s.strip_prefix('#') else {
        return false;
    };
    (hex.len() == 3 || hex.len() == 6) && hex.bytes().all(|b| b.is_ascii_hexdigit())
}
