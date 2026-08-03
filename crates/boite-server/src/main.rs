mod agent_api;
mod auth;
mod config;
mod events;
mod notify;
mod protocol;
mod push;
mod registry;
mod rpc;
mod state;
mod ws;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::connect_info::ConnectInfo;
use axum::extract::{State, WebSocketUpgrade};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;
use tower_http::services::{ServeDir, ServeFile};

use auth::Auth;
use boite_core::scope::ProjectRoots;
use config::Config;
use events::AppEvent;
use registry::Registry;
use state::AppState;
use boite_core::store::{ColVal, Store, ThreadCol};

const EVENT_CHANNEL_CAP: usize = 1024;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "boite_server=info".into()),
        )
        .init();

    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[boite-server] config error: {e}");
            std::process::exit(1);
        }
    };

    let db_path = config.data_dir.join("boite.db");
    let store = match Store::open(&db_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[boite-server] store error: {e}");
            std::process::exit(1);
        }
    };
    let store = Arc::new(store);

    let (events, _) = broadcast::channel::<AppEvent>(EVENT_CHANNEL_CAP);
    let emit = make_event_emitter(store.clone(), events.clone());
    // The status ticker needs to know which threads are claude's and which
    // session each holds, so it can ask claude itself instead of inferring a
    // turn from an OSC title that stopped arriving. Those two columns live in
    // the thread table, which the PTY registry has no business owning.
    let identity = {
        let store = store.clone();
        Arc::new(move |thread_id: &str| {
            store
                .load_thread(thread_id)
                .ok()
                .flatten()
                .map(|t| registry::ThreadIdentity {
                    icon_key: t.icon_key,
                    session_id: t.session_id,
                })
        }) as registry::IdentityLookup
    };
    let registry = Registry::new(config.scrollback_bytes, emit, identity);
    // Shared rather than owned by the state: the agent endpoint decides where a
    // project may be created, and it has to read the same boundary the RPC does,
    // including every refresh after a project is added.
    let roots = Arc::new(ProjectRoots::default());
    let notifier = notify::Notifier::from_env();
    let push = push::PushManager::load(&config.data_dir);

    // Loopback only, and a secret of its own: the main server may be bound to a
    // routable interface, and an agent appending to a checklist is not the same
    // principal as a device driving the workspace.
    let devices = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let agent_api = agent_api::start(
        store.clone(),
        events.clone(),
        roots.clone(),
        config.workspace_dir.clone(),
        devices.clone(),
        config.data_dir.clone(),
        registry.clone(),
    )
    .await;

    let state = Arc::new(AppState {
        store,
        agent_api,
        registry,
        auth: Auth::new(config.token.clone()),
        roots,
        events: events.clone(),
        notifier,
        push,
        max_threads: config.max_threads,
        max_connections: config.max_connections,
        conns: std::sync::atomic::AtomicUsize::new(0),
        devices,
        workspace_dir: config.workspace_dir,
        data_dir: config.data_dir,
        claimed_requests: Default::default(),
    });

    if let Err(e) = state.refresh_roots() {
        tracing::warn!("failed to load project roots: {e}");
    }

    // One task drives every outbound notification on thread transitions: the
    // optional webhook plus Web Push. Push is always on (keys are generated at
    // first run), so the task runs unconditionally; each sink no-ops when it has
    // nothing to deliver (webhook unconfigured / no push subscriptions).
    if state.notifier.enabled() {
        tracing::info!("webhook notifications enabled");
    }
    tracing::info!("web push enabled (VAPID public key in data dir)");
    spawn_notifier_task(state.clone(), events.subscribe());

    // Never log the token itself: logs land in journald/docker/CI where the
    // on-disk token file's 0600 protection does not apply. The operator reads
    // it from the data dir (or sets BOITE_TOKEN).
    tracing::info!("auth token loaded ({} chars)", config.token.len());
    tracing::info!("listening on {}", config.bind);
    if !config.bind.starts_with("127.") && !config.bind.starts_with("[::1]") {
        tracing::warn!(
            "bound to a routable interface ({}); the token is sent over plain ws:// \
             unless you front it with TLS (reverse proxy) or a tunnel (WireGuard/SSH)",
            config.bind
        );
    }

    let mut app = Router::new()
        .route("/api/health", get(health))
        .route("/.well-known/assetlinks.json", get(assetlinks))
        .route("/ws", get(ws_upgrade));

    if let Some(dir) = &config.static_dir {
        let index = dir.join("index.html");
        let serve = ServeDir::new(dir).fallback(ServeFile::new(index));
        app = app.fallback_service(serve);
    }

    let registry_for_shutdown = state.registry.clone();
    let app = app.with_state(state);

    let listener = match tokio::net::TcpListener::bind(&config.bind).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[boite-server] bind {} failed: {e}", config.bind);
            std::process::exit(1);
        }
    };

    let serve = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    );

    if let Err(e) = serve
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            tracing::info!("shutdown: killing PTYs");
            // kill_all spawns + joins one OS thread per PTY; keep it off the
            // async worker so a slow killer syscall can't stall the runtime.
            let _ = tokio::task::spawn_blocking(move || {
                registry_for_shutdown.pty_manager().kill_all();
            })
            .await;
        })
        .await
    {
        tracing::error!("server error: {e}");
    }
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = match signal(SignalKind::terminate()) {
        Ok(s) => s,
        Err(_) => {
            let _ = tokio::signal::ctrl_c().await;
            return;
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn health() -> &'static str {
    "ok"
}

// Digital Asset Links for the Android TWA: proves boite.net.tasbem.ch and the
// signed APK belong together so the browser drops the URL bar. The file is
// dropped into the data dir after the APK is built (it carries the signing
// cert SHA-256), so it is served from disk, not baked into the binary. 404
// until present, which is harmless for the PWA.
async fn assetlinks(State(state): State<Arc<AppState>>) -> Response {
    let path = state.data_dir.join("assetlinks.json");
    match tokio::fs::read(&path).await {
        Ok(bytes) => (
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            bytes,
        )
            .into_response(),
        Err(_) => axum::http::StatusCode::NOT_FOUND.into_response(),
    }
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    ws.on_upgrade(move |socket| ws::handle_socket(socket, state, addr))
        .into_response()
}

// Persist critical thread transitions before fanning them out. Broadcast is a
// lossy delivery mechanism under load; durable state must not depend on a
// receiver task keeping up.
fn make_event_emitter(
    store: Arc<Store>,
    tx: broadcast::Sender<AppEvent>,
) -> Arc<dyn Fn(AppEvent) + Send + Sync> {
    Arc::new(move |event: AppEvent| {
        match &event {
            AppEvent::ThreadStatus {
                thread_id,
                status,
                exit_code,
            } => {
                if let Err(e) =
                    store.update_thread_field(thread_id, ThreadCol::Status, ColVal::Text(status.clone()))
                {
                    tracing::warn!("failed to persist thread status: {e}");
                }
                if let Some(c) = exit_code {
                    if let Err(e) =
                        store.update_thread_field(thread_id, ThreadCol::ExitCode, ColVal::Int(*c as i64))
                    {
                        tracing::warn!("failed to persist thread exit code: {e}");
                    }
                }
            }
            AppEvent::ThreadTitle { thread_id, title } => {
                if let Err(e) =
                    store.update_thread_field(thread_id, ThreadCol::Title, ColVal::Text(title.clone()))
                {
                    tracing::warn!("failed to persist thread title: {e}");
                }
            }
            _ => {}
        }
        let _ = tx.send(event);
    })
}

// Fire a webhook on meaningful thread transitions: a turn finishing
// (running -> ready, claude awaiting input) and process exit. Tracks the last
// status per thread so a status that did not actually cross an edge is silent.
fn spawn_notifier_task(state: Arc<AppState>, mut rx: broadcast::Receiver<AppEvent>) {
    use std::collections::HashMap;
    tokio::spawn(async move {
        let mut last: HashMap<String, String> = HashMap::new();
        loop {
            match rx.recv().await {
                Ok(AppEvent::ThreadStatus {
                    thread_id, status, ..
                }) => {
                    let prev = last.insert(thread_id.clone(), status.clone());
                    if prev.as_deref() == Some(status.as_str()) {
                        continue;
                    }
                    let fire = match status.as_str() {
                        // A turn that ended. Not from `waiting`: dismissing a
                        // dialog without answering is not the agent finishing.
                        "ready" => prev.as_deref() == Some("running"),
                        // Always worth a buzz: nothing moves until the user
                        // answers, so this is the one status that is a request.
                        "waiting" => true,
                        "exited" | "error" | "done" => true,
                        _ => false,
                    };
                    if !fire {
                        continue;
                    }
                    let label = state
                        .store
                        .thread_label(&thread_id)
                        .unwrap_or_else(|| "thread".to_string());
                    let (title, body, tag) = match status.as_str() {
                        "ready" => (format!("{label}: ready"), "Awaiting input".to_string(), "bell"),
                        "waiting" => (
                            format!("{label}: needs you"),
                            "Waiting for your answer".to_string(),
                            "bell",
                        ),
                        "done" => (
                            format!("{label}: done"),
                            "Process finished".to_string(),
                            "white_check_mark",
                        ),
                        _ => (
                            format!("{label}: {status}"),
                            "Process exited".to_string(),
                            "x",
                        ),
                    };
                    state.notifier.send(&title, &body, tag).await;
                    state.push.notify_all(&state.store, &title, &body, tag).await;
                }
                Ok(_) => {}
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });
}
