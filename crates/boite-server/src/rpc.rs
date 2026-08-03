use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use boite_core::capability::Grant;
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
            if thread.created_at == 0 {
                thread.created_at = now_ms();
            }
            thread.status = "running".to_string();
            // Before the key is minted: `bind_thread_identity` updates a row,
            // and there is no row until this runs.
            state.store.save_thread(&thread)?;

            // The server spawns the child, so it hands it credentials no client
            // could forge: a key minted for this thread alone, in a file only
            // this user can read. Stamped last so a client-supplied env cannot
            // override them.
            //
            // A thread that cannot be given a key opens anyway, without Boite
            // tools. The alternative is refusing to open a terminal because its
            // todo list would be missing, which is the wrong thing to lose.
            if let Some(api) = &state.agent_api {
                match boite_agent_api::keys::mint(&state.store, &api.keys_dir, &thread.id) {
                    Ok(key_path) => {
                        env.insert(boite_agent_api::env::URL.into(), api.url.clone());
                        env.insert(
                            boite_agent_api::env::KEY_FILE.into(),
                            key_path.to_string_lossy().into_owned(),
                        );
                        env.insert(boite_agent_api::env::THREAD.into(), thread.id.clone());
                    }
                    Err(e) => tracing::warn!("thread {} spawns without tools: {e}", thread.id),
                }
            }
            let env = Some(env);

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
            // EXISTING row keep the persisted status/exit_code and announce it
            // as an update; only a genuinely new row is idle + created.
            //
            // "Persisted" is `Store::thread_status`, which collapses anything
            // that is not a terminal status to idle. So a closed thread keeps
            // its ending and a busy one does not keep its claim — a row that
            // says `running` describes a process that stopped existing when the
            // last one of these ended.
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
            // The row is what a public key is looked up on, so the file grants
            // nothing once it is gone. Removed anyway rather than left to
            // accumulate one per thread ever opened.
            if let Some(api) = &state.agent_api {
                boite_agent_api::keys::forget(&api.keys_dir, &id);
            }
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

        // What an agent has put in front of the user, and the user's answer.
        // Not scoped to a project: an agent in another one asking to move is
        // exactly what would otherwise be invisible from wherever a device
        // happens to be standing.
        "approval.list" => {
            let api = state.agent_api.as_ref().ok_or("the agent endpoint is not running")?;
            Ok(json!({ "approvals": api.workspace.store().open_approvals()? }))
        }

        "approval.decide" => {
            use boite_core::approval::Verdict;
            let api = state.agent_api.as_ref().ok_or("the agent endpoint is not running")?;
            let id = str_param(&params, "id")?;
            let allow = params.get("allow").and_then(|v| v.as_bool()).unwrap_or(false);
            let verdict = if allow { Verdict::Allowed } else { Verdict::Refused };
            // `None` is another device having answered first, not a failure:
            // the request has been dealt with either way.
            let decided = boite_agent_api::decide(&*api.workspace, &id, verdict, now_ms())?;
            Ok(json!({ "decided": decided }))
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
            // `Local`: this is a device that authenticated on the workspace's
            // own token, which is the user, not an agent. Agents reach the bus
            // through their own endpoint and carry a narrower grant.
            let ready = command.prepare(&state.command_host(), Grant::Local)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::state_for_test;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("boite-rpc-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    async fn call(state: &AppState, method: &str, params: Value) -> Result<Value, String> {
        dispatch(state, method, params).await
    }

    #[tokio::test]
    async fn a_method_nobody_serves_is_refused_by_name() {
        let dir = scratch("unknown");
        let state = state_for_test(&dir);
        assert_eq!(
            call(&state, "thread.explode", json!({})).await.unwrap_err(),
            "unknown method: thread.explode"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The trust boundary, through the real dispatcher rather than through the
    /// bus directly: this is the path a client actually reaches.
    #[tokio::test]
    async fn a_path_outside_the_roots_is_refused_through_the_dispatcher() {
        let dir = scratch("scope");
        let state = state_for_test(&dir);
        let err = call(&state, "git.status", json!({ "path": dir.to_str().unwrap() }))
            .await
            .unwrap_err();
        assert!(err.contains("outside registered project roots"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Creating a project is what puts its folder inside the boundary, and the
    /// two have to happen together: a project whose folder is not a root is a
    /// project nothing in it can be read from.
    #[tokio::test]
    async fn creating_a_project_is_what_opens_its_folder() {
        let dir = scratch("project");
        let state = state_for_test(&dir);
        assert!(call(&state, "git.status", json!({ "path": dir.to_str().unwrap() }))
            .await
            .is_err());

        call(
            &state,
            "project.create",
            json!({ "project": {
                "id": "p", "name": "p", "cwd": dir.to_str().unwrap(),
                "icon": null, "archived": false,
            }}),
        )
        .await
        .unwrap();

        // Not refused any more: the folder is a root. Whether it is a repository
        // is another question, and the one git answers.
        let after = call(&state, "git.repoInfo", json!({ "path": dir.to_str().unwrap() })).await;
        assert!(after.is_ok(), "{after:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The client is not authoritative for runtime state. `thread.create`
    /// doubles as create and re-save — a session id captured, a label edited —
    /// and taking the client's word on the second call would let a reload
    /// rewrite how a thread ended.
    ///
    /// What survives is a terminal status. What does not is `running`: a row
    /// claiming it describes a process that stopped existing when the last
    /// server did, which is `Store::thread_status`'s job to know rather than
    /// this handler's.
    #[tokio::test]
    async fn re_saving_a_thread_keeps_how_it_ended_and_not_what_it_claims() {
        let dir = scratch("thread");
        let state = state_for_test(&dir);
        let row = |status: &str| {
            json!({ "thread": {
                "id": "t1", "projectId": "p", "label": "one", "cmd": "bash",
                "args": [], "status": status, "createdAt": 0,
            }})
        };

        // A new row is idle whatever the client says it is.
        let first = call(&state, "thread.create", row("running")).await.unwrap();
        assert_eq!(first["thread"]["status"], json!("idle"));

        // How it ended is the server's, and a re-save cannot rewrite it.
        state
            .store
            .update_thread_field("t1", ThreadCol::Status, ColVal::Text("exited".into()))
            .unwrap();
        state
            .store
            .update_thread_field("t1", ThreadCol::ExitCode, ColVal::Int(3))
            .unwrap();
        let again = call(&state, "thread.create", row("idle")).await.unwrap();
        assert_eq!(again["thread"]["status"], json!("exited"));
        assert_eq!(again["thread"]["exitCode"], json!(3));

        // And a stored `running` reads back as idle: the process it named is
        // gone, so keeping the word would be a thread that is busy with nothing.
        state
            .store
            .update_thread_field("t1", ThreadCol::Status, ColVal::Text("running".into()))
            .unwrap();
        let restarted = call(&state, "thread.create", row("running")).await.unwrap();
        assert_eq!(restarted["thread"]["status"], json!("idle"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The colour lands in a CSS custom property on every connected client, so
    /// anything that is not a hex colour is dropped rather than stored.
    #[tokio::test]
    async fn a_workspace_colour_that_is_not_a_colour_is_dropped() {
        let dir = scratch("workspace");
        let state = state_for_test(&dir);
        let set = |value: Value| json!({ "color": value });

        call(&state, "workspace.setInfo", set(json!("#0af"))).await.unwrap();
        let kept = call(&state, "workspace.info", json!({})).await.unwrap();
        assert_eq!(kept["color"], json!("#0af"));

        for bad in ["red", "#gggggg", "url(x)", "#12345"] {
            call(&state, "workspace.setInfo", set(json!(bad))).await.unwrap();
            let after = call(&state, "workspace.info", json!({})).await.unwrap();
            assert_eq!(after["color"], json!("#0af"), "{bad} was stored");
        }

        // Explicit null is how a client clears it, and has to keep working.
        call(&state, "workspace.setInfo", set(Value::Null)).await.unwrap();
        assert_eq!(
            call(&state, "workspace.info", json!({})).await.unwrap()["color"],
            Value::Null
        );

        // The name is capped rather than refused: it is text on a chip, not a
        // value anything parses.
        call(&state, "workspace.setInfo", json!({ "name": "x".repeat(200) }))
            .await
            .unwrap();
        let named = call(&state, "workspace.info", json!({})).await.unwrap();
        assert_eq!(named["name"].as_str().unwrap().chars().count(), 64);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The server POSTs to a push endpoint on its own, unprompted, on every
    /// thread transition. Registering one unchecked is how a client borrows the
    /// server's reach into its own network.
    #[tokio::test]
    async fn a_push_endpoint_the_server_should_not_reach_is_refused() {
        let dir = scratch("push");
        let state = state_for_test(&dir);
        let subscribe = |endpoint: &str| {
            json!({
                "endpoint": endpoint,
                "keys": { "p256dh": "a", "auth": "b" },
            })
        };
        for bad in [
            "http://192.168.1.1/push",
            "http://127.0.0.1/push",
            "https://localhost/push",
            "ftp://example.com/push",
        ] {
            assert!(
                call(&state, "push.subscribe", subscribe(bad)).await.is_err(),
                "{bad} was accepted"
            );
        }
        call(&state, "push.subscribe", subscribe("https://push.example.com/x"))
            .await
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An agent request reaches every connected device and exactly one of them
    /// may act on it: two clients running the same move would kill one PTY
    /// twice and leave a second worktree behind.
    #[tokio::test]
    async fn exactly_one_caller_claims_an_agent_request() {
        let dir = scratch("claim");
        let state = state_for_test(&dir);
        let id = json!({ "requestId": "abc" });
        assert_eq!(
            call(&state, "agent.claimRequest", id.clone()).await.unwrap()["claimed"],
            json!(true)
        );
        assert_eq!(
            call(&state, "agent.claimRequest", id).await.unwrap()["claimed"],
            json!(false)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
