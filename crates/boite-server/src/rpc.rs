use serde_json::{json, Value};

use boite_core::capability::Grant;
use boite_core::command::{self, Command};
use boite_core::pairing::ScopeSet;
use boite_core::pty::PtySpawnArgs;

use crate::authz::Authorized;
use crate::events::AppEvent;
use crate::state::AppState;
use boite_core::model::Thread;
use boite_core::now_ms;

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

/// Which OS the threads run on.
///
/// Decided at compile time rather than probed: this binary was built for one
/// target and cannot be running on another, so there is nothing here that can
/// disagree with the machine underneath it.
fn os_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

fn non_empty(s: &str) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// What this machine calls itself, out of what it was already told.
///
/// A container carries `HOSTNAME` in its environment, Windows sets
/// `COMPUTERNAME`, and the rest keep it in a file. No process is spawned to ask:
/// a name on a settings card is not worth a fork, and shelling out for one is
/// how a server ends up running `hostname` on every reconnect.
///
/// None of the three is guaranteed, and `None` is the answer when none of them
/// is there. A placeholder would be a machine name that names no machine, which
/// is worse on that card than an empty row.
fn host_name() -> Option<String> {
    ["HOSTNAME", "COMPUTERNAME"]
        .into_iter()
        .find_map(|key| std::env::var(key).ok().and_then(|v| non_empty(&v)))
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .and_then(|s| non_empty(&s))
        })
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

/// Runs a record command on the bus and hands back the bare answer.
///
/// The rows are `boite_core::command::records`; what stays on this side is what
/// this host does *about* a row changing — broadcasting to every connected
/// device, refreshing the roots, killing a PTY. Those are not the capability,
/// and a bus that owned them would need a `Host` method per host quirk.
///
/// Bare rather than wire-wrapped: the arms below already carry the envelope
/// this protocol has always used, and the fallthrough at the bottom is what
/// applies `Wire` for the commands that need nothing around them.
async fn on_bus(state: &AppState, method: &str, params: &Value) -> Result<Value, String> {
    let ready = Command::decode(method, params)?.prepare(&state.command_host(), Grant::Local)?;
    blocking(move || ready.run()).await?
}

// Dispatch every non-streaming method. thread.attach / thread.detach and
// binary input frames are handled in ws.rs (they need the socket writer).
//
// The argument is an `Authorized` rather than a method and its parameters,
// which is what makes the scope check unskippable: there is no other way to
// build one, so no arm below can be reached by a device that was not paired for
// it. See `crate::authz`.
pub async fn dispatch(state: &AppState, request: Authorized) -> Result<Value, String> {
    let method = request.method().to_string();
    let caller = request.caller();
    let params = request.into_params();
    match method.as_str() {
        // Who answered, not just that something did. The protocol number keeps
        // its place at the front; the three beside it are here because a
        // connected client had no way at all to name the machine it was driving.
        // The settings panel printed `__APP_VERSION__`, a constant Vite bakes
        // into the bundle the browser downloaded, one row above a line saying
        // the workspace was somewhere else: never a wrong number, always about
        // the wrong machine.
        //
        // `version` is this crate's, resolved at compile time, so it describes
        // the binary that is running rather than a manifest sitting next to it.
        // A client older than this ignores the extra fields; a newer one against
        // a server older than this gets none of them and draws that as "it did
        // not say", which is why nothing here is defaulted.
        "hello" => Ok(json!({
            "ok": true,
            "protocol": 1,
            "version": env!("CARGO_PKG_VERSION"),
            "platform": os_name(),
            "host": host_name(),
        })),

        // The rows come from the bus; what this host adds is which of them has a
        // process behind it right now. Kept as two steps rather than folded into
        // the command, because the difference between the two is the thing worth
        // seeing: a row saying `running` with no live PTY is the shape of nearly
        // every "my terminal is dead" report, and `system.snapshot` reports it by
        // handing over both lists separately.
        "thread.list" => {
            let mut threads: Vec<Thread> =
                serde_json::from_value(on_bus(state, "thread.list", &params).await?)
                    .map_err(|e| format!("bad thread rows: {e}"))?;
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
            let mut spawn_args = thread.args.clone();
            // The sidecar lives on this host. A client on another machine
            // cannot name it, so the flags are added here, once, in front of
            // `--` so a Claude prompt is not read as a second config file.
            if let Some(paths) = state.agent_api.as_ref().and_then(|api| api.mcp.as_ref()) {
                let selected = state
                    .store
                    .load_projects()?
                    .into_iter()
                    .find(|project| project.id == thread.project_id)
                    .and_then(|project| project.mcp_server_ids);
                spawn_args = boite_core::mcp_launch::inject_project(
                    &thread.cmd,
                    spawn_args,
                    paths,
                    &thread.project_id,
                    selected.as_deref(),
                    true,
                )?;
            }
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
            // The role hint for the shim's tool tier, read off the row Boite
            // stamped. A hint only: the endpoint re-checks the row per call.
            if let Some((Some(role), scope, _)) = state.store.thread_orchestration(&thread.id) {
                env.insert(boite_agent_api::env::ROLE.into(), role);
                if let Some(scope) = scope {
                    env.insert(boite_agent_api::env::ORCHESTRATOR_SCOPE.into(), scope);
                }
                let autonomy = state
                    .store
                    .load_settings()
                    .ok()
                    .and_then(|s| {
                        s.get("orchestratorAutonomy")
                            .and_then(|v| v.as_str())
                            .map(str::to_string)
                    })
                    .unwrap_or_else(|| "observer".to_string());
                env.insert(boite_agent_api::env::AUTONOMY.into(), autonomy);
            }
            let env = Some(env);

            let wrap = params
                .get("wrap")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let spec = PtySpawnArgs {
                cwd,
                cmd: thread.cmd.clone(),
                args: spawn_args,
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
            // Whether this is a create or a re-save is read before the row is
            // written, because it decides which event every connected device
            // gets. The row work itself, including refusing to take the
            // client's word for a run that has already ended, is on the bus.
            let existed = params
                .get("thread")
                .and_then(|t| t.get("id"))
                .and_then(|v| v.as_str())
                .and_then(|id| state.store.thread_status(id))
                .is_some();
            let thread = on_bus(state, "thread.create", &params).await?;
            let _ = state.events.send(if existed {
                AppEvent::ThreadUpdated(thread.clone())
            } else {
                AppEvent::ThreadCreated(thread.clone())
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
            on_bus(state, "thread.update", &params).await?;
            // The full persisted row, so clients merge the fields the user owns
            // (label/title/iconKey/sessionId/keepAwake). They ignore the runtime
            // ones here; those flow through the thread.status control event and
            // the live overlay.
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
            on_bus(state, "thread.delete", &params).await?;
            // The row and the key binding go on the bus; the key *file* is this
            // host's own directory and no other host has one to remove.
            if let Some(api) = &state.agent_api {
                boite_agent_api::keys::forget(&api.keys_dir, &id);
            }
            let _ = state.events.send(AppEvent::ThreadDeleted {
                thread_id: id.clone(),
            });
            Ok(json!({ "ok": true }))
        }

        "project.create" => {
            // Two boundaries, and they are not the same one. The bus applies
            // *where* a project may go, which a desktop has too. This applies
            // the half only a server has: the folder must already be a
            // directory, because nobody is standing at this machine to make it.
            let cwd = params
                .get("project")
                .and_then(|p| p.get("cwd"))
                .and_then(|v| v.as_str())
                .ok_or("missing param: project.cwd")?;
            state.ensure_project_path(cwd)?;
            let project = on_bus(state, "project.create", &params).await?;
            state.refresh_roots()?;
            let _ = state.events.send(AppEvent::ProjectChanged);
            Ok(json!({ "project": project }))
        }

        "project.archive" => {
            on_bus(state, "project.archive", &params).await?;
            // Archived projects are out of the registered roots, so the
            // boundary every path-taking command is checked against moves with
            // this. That is why it is not just a flag on a row.
            state.refresh_roots()?;
            let _ = state.events.send(AppEvent::ProjectChanged);
            Ok(json!({ "ok": true }))
        }

        "project.delete" => {
            on_bus(state, "project.delete", &params).await?;
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
                // No window on this side, so nothing describes one. A device
                // attached to this server has its own, and answers for it from
                // its own snapshot.
                boite_core::snapshot::take("server", &store, &roots, live, None)
            })
            .await?;
            Ok(serde_json::to_value(taken).unwrap())
        }

        "agent.claimRequest" => {
            let id = str_param(&params, "requestId")?;
            Ok(json!({ "claimed": state.claim_agent_request(&id) }))
        }

        "agent.answerRequest" => {
            let id = str_param(&params, "requestId")?;
            let payload = params.get("payload").cloned().unwrap_or(json!({}));
            let answered = state
                .agent_api
                .as_ref()
                .map(|api| api.answer(&id, payload))
                .unwrap_or(false);
            Ok(json!({ "answered": answered }))
        }

        "agent.mcpConfig" => {
            let Some(paths) = state.agent_api.as_ref().and_then(|api| api.mcp.as_ref()) else {
                return Err("no MCP shim on this host".into());
            };
            Ok(json!({
                "sidecarPath": paths.sidecar,
                "configPath": paths.config,
                "settingsPath": paths.settings,
            }))
        }

        "settings.set" => {
            on_bus(state, "settings.set", &params).await?;
            let _ = state.events.send(AppEvent::SettingsChanged);
            Ok(json!({ "ok": true }))
        }

        "todo.save" => {
            on_bus(state, "todo.save", &params).await?;
            let _ = state.events.send(AppEvent::TodosChanged);
            Ok(json!({ "ok": true }))
        }

        "todo.delete" => {
            on_bus(state, "todo.delete", &params).await?;
            let _ = state.events.send(AppEvent::TodosChanged);
            Ok(json!({ "ok": true }))
        }

        "workspace.setInfo" => {
            on_bus(state, "workspace.setInfo", &params).await?;
            // Read back rather than echoed: a colour the bus refused must not
            // travel to every connected device as if it had been taken.
            let info = on_bus(state, "workspace.info", &json!({})).await?;
            let of = |key: &str| info.get(key).and_then(|v| v.as_str()).map(str::to_string);
            let _ = state.events.send(AppEvent::WorkspaceInfo {
                name: of("name"),
                color: of("color"),
            });
            Ok(info)
        }

        // Which OS the threads run on. The device drawing the UI cannot work
        // this out for itself: a browser has no way to ask, and a Windows
        // desktop driving this boite would answer for its own machine and then
        // pick a Windows shell out of a Linux list.
        "system.platform" => Ok(json!({ "platform": os_name() })),

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
            let thread_id = params
                .get("threadId")
                .and_then(|v| v.as_str())
                .unwrap_or("test")
                .to_string();
            let who = state.store.thread_context(&thread_id);
            // A real awareness value rather than a hand-made pair of strings, so
            // what a fresh deployment receives is shaped exactly like what it
            // will receive in anger — the link included, which is the half most
            // likely to be misconfigured.
            let aware = boite_core::awareness::derive(&boite_core::awareness::Facts {
                thread_id: &thread_id,
                label: who
                    .as_ref()
                    .map(|w| w.label.as_str())
                    .unwrap_or("Test terminal"),
                project_id: who.as_ref().and_then(|w| w.project_id.as_deref()),
                project: who.as_ref().and_then(|w| w.project.as_deref()),
                status: boite_core::status::ThreadStatus::Waiting,
                exit_code: None,
                has_process: true,
                approval: None,
            });
            state.notifier.send(&aware).await;
            Ok(json!({ "ok": true, "enabled": state.notifier.enabled() }))
        }

        // Answering a dialog that is up in a terminal, from wherever the user
        // happens to be. The bound is `boite_core::reply`: a closed vocabulary
        // of single keystrokes, nothing that can carry a payload.
        //
        // This arm is why the capability is here rather than on the command bus.
        // `dispatch` is reached only after `ws::authenticate`, so the caller is a
        // device holding the workspace token, which is the user; an agent reaches
        // the bus through its own endpoint with a narrower grant, and there is
        // deliberately no route on that endpoint for this. An agent able to
        // answer its own permission prompts has no permission prompts.
        //
        // It does **not** require the socket to have attached to the thread, and
        // the binary input frame in `ws.rs` does. That is not an oversight and
        // the two rules are answering different questions: attachment is what
        // stops a client streaming keystrokes into a terminal it is not looking
        // at, and the whole point of this call is a phone that has never opened
        // this terminal answering the notification that woke it. What replaces
        // attachment as the bound is the vocabulary, which is why it is a parsed
        // token here and raw bytes there.
        "thread.reply" => {
            let thread_id = str_param(&params, "threadId")?;
            let reply = boite_core::reply::Reply::parse(&str_param(&params, "answer")?)?;
            state.registry.write(&thread_id, reply.bytes())?;
            Ok(json!({ "ok": true }))
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

        // `search.query` was here, hand-written over the same store and the same
        // transcripts directory the desktop had no way to reach at all. It is
        // `boite_core::command::records` now, so the window and a device ask for
        // it in one vocabulary and the envelope below is unchanged.
        "timeline.read" => {
            let limit = params
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(40)
                .clamp(1, 200) as usize;
            let project = params
                .get("project")
                .and_then(|v| v.as_str())
                .filter(|p| !p.is_empty())
                .map(|p| p.to_string());
            let store = state.store.clone();
            let moments =
                blocking(move || store.timeline(project.as_deref(), limit)).await?;
            Ok(json!({ "moments": moments }))
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

        // Every device that has ever been paired, revoked ones included. A
        // revoked row is struck through rather than deleted: the question a
        // compromised phone raises is when it last reached this workspace, and a
        // deleted row answers nothing.
        "pairing.list" => Ok(json!({ "pairings": state.store.list_pairings()? })),

        // Invites one device. What comes back is the only copy of the token —
        // the table keeps a hash — so it is drawn once, as a link and a QR, and
        // never fetched again.
        //
        // `base` is the client's own origin, because a server behind a reverse
        // proxy does not know the name it is reached by. It decides what the
        // link *says*, never what the token opens, and a configured
        // `BOITE_PUBLIC_URL` wins over it.
        //
        // Two things this arm may not do, both of which it used to:
        //
        // - grant more than the device asking holds. Admin is what opens this
        //   method, and one paired with admin but no terminal could invite a
        //   device that had one, redeem the link itself, and be holding a shell
        //   nobody ever gave it. `clamped_to` is that fix, and the answer names
        //   the set that was actually minted so the caller is never guessing;
        // - read a malformed `scopes` as "no preference". `.ok()` on the decode
        //   turned `{"scopes":"trminal"}`, or any shape that is not a list of
        //   names, into the standard set, which is wider than what was asked
        //   for. A request nobody can read is refused instead: widening on
        //   malformed input is the one direction that cannot be allowed.
        //
        // The operator paths (`boite-server pair`, `POST /api/pairings`) are
        // deliberately not clamped. They present the bootstrap token, which is
        // the trust root this whole scheme hangs off; there is no wider grant
        // above them to clamp against.
        "pairing.create" => {
            let label = params.get("label").and_then(|v| v.as_str()).unwrap_or("");
            let kind = params.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let asked: ScopeSet = match params.get("scopes") {
                Some(raw) => serde_json::from_value(raw.clone())
                    .map_err(|_| "scopes must be a list of scope names".to_string())?,
                None => ScopeSet::standard(),
            };
            let scopes = asked.clamped_to(caller);
            if scopes.is_empty() {
                return Err("a pairing with no scopes could do nothing".into());
            }
            let ttl_ms = params
                .get("ttlMs")
                .and_then(|v| v.as_i64())
                .unwrap_or(crate::pairing_link::DEFAULT_TTL_MS)
                .clamp(60_000, 24 * 3_600_000);
            let now = now_ms();
            let token = crate::auth::mint_pairing_token(
                &state.store, label, kind, scopes, now, ttl_ms,
            )?;
            let base = state
                .public_url
                .clone()
                .or_else(|| {
                    params
                        .get("base")
                        .and_then(|v| v.as_str())
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                })
                .unwrap_or_default();
            let url = boite_core::pairing::pairing_url(&base, &token);
            Ok(json!({
                "token": token,
                "url": url,
                "expiresAt": now + ttl_ms,
                "scopes": scopes,
                "qr": crate::pairing_link::qr_matrix(&url),
            }))
        }

        // The way out for the way in. A revoked pairing stops at once: its
        // unspent tickets are dropped, every socket holding it is told to go,
        // and the next call it makes reads the row rather than what its
        // handshake decided.
        "pairing.revoke" => {
            let id = str_param(&params, "id")?;
            let revoked = state.store.revoke_pairing(&id, now_ms())?;
            if revoked {
                state.auth.drop_tickets_of(&id);
                let _ = state.events.send(AppEvent::PairingRevoked { pairing_id: id });
            }
            Ok(json!({ "revoked": revoked }))
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
            let answer = blocking(move || ready.run()).await??;
            // A moment is what an orchestrator's long-poll wakes on, and the
            // event is what a chat pane refreshes on. Fanned out here because
            // the bus itself owns no event channel. Every conduct write that
            // appended one answers with its seq: record, post, say, start.
            if m.starts_with("conduct.")
                || m.starts_with("orchestrator.")
                || m.starts_with("dispatch.")
                || m.starts_with("thread.dispatch")
            {
                if let Some(seq) = answer.get("seq").and_then(|v| v.as_i64()) {
                    if m != "conduct.pulse" {
                        let _ = state.events.send(AppEvent::MomentAppended { seq });
                    }
                }
                if m == "orchestrator.start" {
                    let _ = state.events.send(AppEvent::OrchestratorChanged);
                }
                // The one device that owns the target PTY flushes on this.
                if m == "thread.dispatch" {
                    if let (Some(to), Some(id)) = (
                        params.get("toThreadId").and_then(|v| v.as_str()),
                        answer.get("dispatchId").and_then(|v| v.as_str()),
                    ) {
                        let _ = state.events.send(AppEvent::DispatchQueued {
                            thread_id: to.to_string(),
                            dispatch_id: id.to_string(),
                        });
                    }
                }
            }
            Ok(wire.wrap(answer))
        }

        other => Err(format!("unknown method: {other}")),
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::state_for_test;
    use boite_core::pairing::Scope;
    use boite_core::store::{ColVal, ThreadCol};

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("boite-rpc-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    /// Through the gate, not around it.
    ///
    /// `dispatch` takes an `Authorized`, so a test cannot reach an arm any way a
    /// socket could not either. The session holds every scope; the checks that
    /// a narrower one is refused live in `crate::authz`, against the same
    /// constructor.
    async fn call(state: &AppState, method: &str, params: Value) -> Result<Value, String> {
        call_as(state, ScopeSet::full(), method, params).await
    }

    /// The same, for the arms whose answer depends on what the caller holds
    /// rather than only on whether it may call at all.
    async fn call_as(
        state: &AppState,
        scopes: ScopeSet,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let session = crate::auth::Session::for_test(scopes);
        let request = Authorized::check(&state.store, &session, method, params)?;
        dispatch(state, request).await
    }

    /// The privilege escalation, walked end to end.
    ///
    /// A device paired with admin and deliberately *without* a terminal asks
    /// for one, redeems its own invitation at the unauthenticated `/api/pair`,
    /// and has to come away without a shell. Asserting on the answer alone
    /// would not prove it: the pairing that lands in the table is what a phone
    /// then connects with, so the token is spent and the row is read.
    #[tokio::test]
    async fn an_admin_without_a_terminal_cannot_invite_itself_one() {
        let dir = scratch("escalate");
        let state = state_for_test(&dir);
        let deskless_admin = ScopeSet::empty().with(Scope::Read).with(Scope::Admin);

        let minted = call_as(
            &state,
            deskless_admin,
            "pairing.create",
            json!({ "label": "a second phone", "scopes": ["read", "terminal"] }),
        )
        .await
        .unwrap();
        assert_eq!(minted["scopes"], json!(["read"]));

        let token = minted["token"].as_str().unwrap();
        let paired = crate::auth::redeem_pairing_token(
            &state.auth,
            std::net::IpAddr::from([127, 0, 0, 1]),
            &state.store,
            token,
            Some("a second phone"),
            "phone",
            now_ms(),
        )
        .expect("the invitation should still redeem, just for less");
        assert!(
            !paired.pairing.scopes.holds(Scope::Terminal),
            "an admin-only device paired itself a shell: {}",
            paired.pairing.scopes.to_text()
        );

        // A device that holds the terminal hands it on, so the ordinary invite
        // is untouched.
        let full = call_as(
            &state,
            ScopeSet::full(),
            "pairing.create",
            json!({ "scopes": ["read", "terminal"] }),
        )
        .await
        .unwrap();
        assert_eq!(full["scopes"], json!(["read", "terminal"]));

        // And a request that clamps down to nothing is refused rather than
        // silently minting an invitation good for nothing.
        let empty = call_as(
            &state,
            ScopeSet::empty().with(Scope::Admin),
            "pairing.create",
            json!({ "scopes": ["terminal"] }),
        )
        .await
        .unwrap_err();
        assert!(empty.contains("no scopes"), "{empty}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Scopes nobody can decode used to read as "no preference", which meant
    /// the standard set: a malformed request coming away with more than it
    /// asked for. It is an error now.
    #[tokio::test]
    async fn a_scopes_field_that_cannot_be_read_is_refused_rather_than_widened() {
        let dir = scratch("scopes-malformed");
        let state = state_for_test(&dir);
        for bad in [json!(7), json!({ "read": true }), json!(null)] {
            let err = call(&state, "pairing.create", json!({ "scopes": bad.clone() }))
                .await
                .unwrap_err();
            assert!(err.contains("list of scope names"), "{bad}: {err}");
        }
        // No `scopes` at all is still the default, which is a stated choice and
        // not a fallback from something unreadable.
        let plain = call(&state, "pairing.create", json!({})).await.unwrap();
        assert_eq!(plain["scopes"], json!(ScopeSet::standard()));
        let _ = std::fs::remove_dir_all(&dir);
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

    /// The handshake names the machine that answered it. A client cannot work
    /// any of this out for itself: its own version describes the bundle it
    /// downloaded, and its own OS is the one the user is sitting at.
    #[tokio::test]
    async fn the_handshake_says_which_build_answered_it() {
        let dir = scratch("hello");
        let state = state_for_test(&dir);
        let hello = call(&state, "hello", json!({})).await.unwrap();
        assert_eq!(hello["protocol"], json!(1));
        assert_eq!(hello["version"], json!(env!("CARGO_PKG_VERSION")));
        // Whichever of the three this test is running on, never the empty
        // string: a platform nobody can act on is the one thing worse than
        // saying nothing.
        let os = hello["platform"].as_str().unwrap();
        assert!(
            ["windows", "macos", "linux", "unknown"].contains(&os),
            "{os}"
        );
        // The host is allowed to be absent. It is not allowed to be present and
        // empty, which is what a trimmed `/etc/hostname` used to leave behind.
        assert!(hello["host"].is_null() || !hello["host"].as_str().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The bound on the one call that writes into a live terminal, checked
    /// where it is actually enforced rather than in the enum that defines it.
    ///
    /// Every refusal below reaches the PTY layer with nothing at all, which is
    /// the property: an answer this dispatcher accepts is one keystroke from a
    /// closed set, and everything else stops here. A hole in this arm is
    /// arbitrary code on the machine hosting the workspace.
    #[tokio::test]
    async fn only_a_bounded_answer_reaches_a_terminal() {
        let dir = scratch("reply");
        let state = state_for_test(&dir);
        for answer in [
            json!(""),
            json!("Y"),
            json!("yes\r"),
            json!("0"),
            json!("10"),
            json!("rm -rf /"),
            json!("\u{1b}[A"),
            json!("enter "),
            json!(1),
            json!(null),
        ] {
            let err = call(&state, "thread.reply", json!({ "threadId": "t", "answer": answer }))
                .await
                .unwrap_err();
            assert!(
                err.contains("not an answer") || err.contains("missing param"),
                "{answer} was refused for the wrong reason: {err}"
            );
        }
        // A token from the vocabulary gets past the parse and is then refused by
        // the registry, which is the only thing left between it and a PTY.
        let err = call(
            &state,
            "thread.reply",
            json!({ "threadId": "nobody", "answer": "enter" }),
        )
        .await
        .unwrap_err();
        assert_eq!(err, "thread not live");
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

        // And a stored `running` reads back as stopped: the process it named is
        // gone, so keeping the word would be a thread that is busy with nothing —
        // and answering `idle` would be a thread that was working when the last
        // server went away drawn like one nobody has ever started.
        state
            .store
            .update_thread_field("t1", ThreadCol::Status, ColVal::Text("running".into()))
            .unwrap();
        let restarted = call(&state, "thread.create", row("running")).await.unwrap();
        assert_eq!(restarted["thread"]["status"], json!("stopped"));
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
