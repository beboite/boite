mod auth;
mod config;
mod events;
mod models;
mod protocol;
mod registry;
mod rpc;
mod state;
mod store;
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
use store::{ColVal, Store};

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

    let (events, _) = broadcast::channel::<AppEvent>(EVENT_CHANNEL_CAP);
    let registry = Registry::new(config.scrollback_bytes, events.clone());
    let roots = ProjectRoots::default();

    let state = Arc::new(AppState {
        store,
        registry,
        auth: Auth::new(config.token.clone()),
        roots,
        events: events.clone(),
    });

    if let Err(e) = state.refresh_roots() {
        tracing::warn!("failed to load project roots: {e}");
    }

    spawn_persistence_task(state.clone(), events.subscribe());

    tracing::info!("boite-server token: {}", config.token);
    tracing::info!("listening on {}", config.bind);

    let mut app = Router::new()
        .route("/api/health", get(health))
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
            registry_for_shutdown.pty_manager().kill_all();
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

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    ws.on_upgrade(move |socket| ws::handle_socket(socket, state, addr))
        .into_response()
}

// Persist status/title/exit transitions so thread.list is correct with zero
// clients attached.
fn spawn_persistence_task(state: Arc<AppState>, mut rx: broadcast::Receiver<AppEvent>) {
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(AppEvent::ThreadStatus {
                    thread_id,
                    status,
                    exit_code,
                }) => {
                    let _ =
                        state
                            .store
                            .update_thread_field(&thread_id, "status", ColVal::Text(status));
                    if let Some(c) = exit_code {
                        let _ = state.store.update_thread_field(
                            &thread_id,
                            "exit_code",
                            ColVal::Int(c as i64),
                        );
                    }
                }
                Ok(AppEvent::ThreadTitle { thread_id, title }) => {
                    let _ = state.store.update_thread_field(
                        &thread_id,
                        "title",
                        ColVal::Text(title),
                    );
                }
                Ok(_) => {}
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });
}
