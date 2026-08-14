//! The three doors that are not the socket.
//!
//! All three exist so that the long-lived credentials never touch a URL and
//! never touch a WebSocket frame. What reaches `/ws` is a ticket, minted here,
//! good for five minutes and for one connection.
//!
//! | Route | Presents | Gets |
//! |---|---|---|
//! | `POST /api/pairings` | the bootstrap token | a one-time pairing token |
//! | `POST /api/pair` | a one-time pairing token | this device's own credential |
//! | `POST /api/ticket` | this device's credential | a ticket for one socket |
//!
//! Every one of them takes its credential in a header or a body, never in the
//! query string: a query reaches the access log of whatever reverse proxy is in
//! front, and nobody rotates those.
//!
//! Every failure is a bare `401` with no body. There is nothing useful to say —
//! "wrong secret" and "revoked" and "expired" are the same answer to whoever is
//! not supposed to be here — and each one counts against the per-IP lockout in
//! `crate::auth`.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use boite_core::now_ms;
use boite_core::pairing::{self, ScopeSet};

use crate::auth;
use crate::events::AppEvent;
use crate::pairing_link;
use crate::state::AppState;

/// What a bearer header carries, if it carries anything.
fn bearer(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    raw.strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The one answer every door gives to anyone it does not recognise.
fn refused() -> Response {
    StatusCode::UNAUTHORIZED.into_response()
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MintBody {
    label: Option<String>,
    kind: Option<String>,
    scopes: Option<ScopeSet>,
    ttl_ms: Option<i64>,
}

/// Mints a one-time pairing token. The bootstrap token's only door.
///
/// This is what keeps `BOITE_TOKEN` from being a session credential while
/// still keeping the operator of a running deployment able to get back in. It
/// pairs a device; it cannot be one.
/// The body is taken as bytes and decoded here, rather than as
/// `Option<Json<MintBody>>`.
///
/// axum 0.8's `Json` yields `None` from `OptionalFromRequest` whenever the
/// content type is not `application/json`, and a `None` here means "no
/// preference", which means [`ScopeSet::standard`]. So a `POST` carrying
/// `{"scopes":["read"]}` under a missing or misspelled header silently minted
/// read **and** write **and** terminal **and** approve: a request the server
/// could not read widening the grant it asked for. Empty is the only body that
/// gets a default now; anything else is decoded or refused.
fn decode_mint(body: &[u8]) -> Result<MintBody, String> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(MintBody::default());
    }
    // Through a `Value` first, for the one shape serde would otherwise accept
    // quietly: a struct also deserializes from a *sequence*, positionally, so
    // `["read"]` reads as a request whose label is "read" and whose scopes were
    // not stated. That is a body meaning one thing and being read as another,
    // on the door that mints grants, which is the whole class of bug this
    // function exists to remove.
    let value: serde_json::Value =
        serde_json::from_slice(body).map_err(|e| format!("this body is not JSON: {e}"))?;
    if !value.is_object() {
        return Err("a mint request is a JSON object".into());
    }
    serde_json::from_value(value).map_err(|e| format!("this body is not a mint request: {e}"))
}

pub async fn mint_pairing(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let ip = addr.ip();
    if state.auth.is_locked(ip) {
        return refused();
    }
    let Some(presented) = bearer(&headers) else {
        return refused();
    };
    if !state.auth.verify_bootstrap(ip, &presented) {
        return refused();
    }
    let body = match decode_mint(&body) {
        Ok(b) => b,
        Err(e) => return (StatusCode::BAD_REQUEST, e).into_response(),
    };
    // No body at all is the operator minting from a shell with nothing but the
    // bootstrap token, and it gets what `boite-server pair` gives: everything
    // but admin. That is a default, not a fallback from something unreadable.
    let scopes = body.scopes.unwrap_or_else(ScopeSet::standard);
    if scopes.is_empty() {
        return (StatusCode::BAD_REQUEST, "a pairing with no scopes could do nothing")
            .into_response();
    }
    let ttl_ms = body
        .ttl_ms
        .unwrap_or(pairing_link::DEFAULT_TTL_MS)
        .clamp(60_000, 24 * 3_600_000);
    let now = now_ms();
    let token = match auth::mint_pairing_token(
        &state.store,
        body.label.as_deref().unwrap_or(""),
        body.kind.as_deref().unwrap_or(""),
        scopes,
        now,
        ttl_ms,
    ) {
        Ok(t) => t,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };
    let base = state.public_url.clone().unwrap_or_default();
    Json(json!({
        "token": token,
        "url": pairing::pairing_url(&base, &token),
        "expiresAt": now + ttl_ms,
        "scopes": scopes,
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairBody {
    token: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    kind: Option<String>,
}

/// Exchanges a one-time pairing token for this device's own credential.
///
/// No bearer header: the token in the body *is* the credential, and it is worth
/// nothing once this has answered. What comes back is the only copy of the
/// device's long-lived secret; the table keeps a hash.
pub async fn pair(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(body): Json<PairBody>,
) -> Response {
    let ip = addr.ip();
    if state.auth.is_locked(ip) {
        return refused();
    }
    let Some(paired) = auth::redeem_pairing_token(
        &state.auth,
        ip,
        &state.store,
        &body.token,
        body.label.as_deref(),
        body.kind.as_deref().unwrap_or(""),
        now_ms(),
    ) else {
        return refused();
    };
    // Never the credential, and never the token: what is worth logging is that
    // a device joined, which is also what the devices screen is for.
    tracing::info!(
        "paired {} ({}) with {}",
        paired.pairing.label,
        paired.pairing.kind,
        paired.pairing.scopes.to_text()
    );
    let _ = state.events.send(AppEvent::PairingsChanged);
    Json(json!({
        "credential": paired.credential,
        "pairing": paired.pairing,
    }))
    .into_response()
}

/// Mints a ticket for one socket.
///
/// The device presents its long-lived credential here, over HTTP, in a header —
/// the last place it appears. From here on the socket sees only the ticket, and
/// only once.
pub async fn ticket(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let ip = addr.ip();
    if state.auth.is_locked(ip) {
        return refused();
    }
    let Some(presented) = bearer(&headers) else {
        return refused();
    };
    let Some(session) = state.auth.verify_device(ip, &state.store, &presented) else {
        return refused();
    };
    // The credential was used, which is what the devices screen calls "last
    // seen". Written here rather than per RPC: one row update per connection
    // instead of one per call, on a database whose fsync budget is the reason
    // it runs with `synchronous = NORMAL`.
    let _ = state.store.touch_pairing(session.pairing_id(), now_ms());
    Json(json!({
        "ticket": state.auth.mint_ticket(&session),
        "expiresInMs": auth::TICKET_TTL.as_millis() as u64,
        "scopes": session.scopes(),
        "label": session.label(),
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use boite_core::pairing::Scope;

    /// The fail-open this door used to have. A body the server cannot read is
    /// refused; it never falls back to a wider grant than the one it names.
    #[test]
    fn a_body_that_cannot_be_read_never_widens_the_grant() {
        // What a client sends with the wrong content type. Under
        // `Option<Json<_>>` this arrived as `None` and minted the standard set.
        let asked = decode_mint(br#"{"scopes":["read"]}"#).unwrap();
        let scopes = asked.scopes.unwrap();
        assert!(scopes.holds(Scope::Read));
        assert!(
            !scopes.holds(Scope::Terminal),
            "a read-only request came away with a shell"
        );

        // Unreadable is an error, not a default.
        assert!(decode_mint(b"scopes=read").is_err());
        assert!(decode_mint(b"{").is_err());
        assert!(decode_mint(b"[\"read\"]").is_err());

        // Only an empty body means "no preference", and the caller decides what
        // that is; nothing here invents scopes.
        assert!(decode_mint(b"").unwrap().scopes.is_none());
        assert!(decode_mint(b"  \n").unwrap().scopes.is_none());
        assert!(decode_mint(b"{}").unwrap().scopes.is_none());
    }
}
