use std::fs;
use std::path::Path;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use web_push_native::jwt_simple::algorithms::ES256KeyPair;
use web_push_native::{Auth, WebPushBuilder};

use crate::store::{PushSub, Store};

// Native Web Push (VAPID, RFC 8030/8291/8292). Lets the PWA receive a system
// notification when a thread finishes a turn or its process exits, even with
// the app closed (the browser's push service wakes the service worker).
// web-push-native does the aes128gcm payload encryption and the VAPID JWT in
// pure Rust (RustCrypto); we POST its built http::Request with the existing
// reqwest+rustls client. p256 generates the keypair.
#[derive(Clone)]
pub struct PushManager {
    client: reqwest::Client,
    /// VAPID private key: the raw 32-byte P-256 scalar (base64url). Decoded per
    /// send into an ES256KeyPair.
    private_b64: String,
    /// VAPID public key: the 65-byte uncompressed point (base64url). Handed to
    /// the browser verbatim as applicationServerKey.
    public_b64: String,
    subject: String,
}

impl PushManager {
    pub fn load(data_dir: &Path) -> PushManager {
        let subject = std::env::var("BOITE_VAPID_SUBJECT")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "mailto:boite@localhost".to_string());
        let (private_b64, public_b64) = load_or_generate_keys(data_dir);
        PushManager {
            client: reqwest::Client::new(),
            private_b64,
            public_b64,
            subject,
        }
    }

    pub fn public_key(&self) -> &str {
        &self.public_b64
    }

    /// Fan a notification out to every stored subscription. Fire-and-forget:
    /// a dead endpoint (404/410) is pruned, any other failure is logged and
    /// skipped so a flaky push service never wedges the event loop.
    pub async fn notify_all(&self, store: &Store, title: &str, body: &str, tag: &str) {
        let subs = match store.list_push_subscriptions() {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("push: list subscriptions failed: {e}");
                return;
            }
        };
        if subs.is_empty() {
            return;
        }
        let payload = serde_json::json!({ "title": title, "body": body, "tag": tag }).to_string();
        for sub in subs {
            match self.send_one(&sub, payload.as_bytes()).await {
                Ok(code) if code == 404 || code == 410 => {
                    let _ = store.delete_push_subscription(&sub.endpoint);
                    tracing::info!("push: pruned expired subscription");
                }
                Ok(code) if !(200..300).contains(&code) => {
                    tracing::warn!("push: endpoint returned {code}");
                }
                Err(e) => tracing::warn!("push: send failed: {e}"),
                _ => {}
            }
        }
    }

    async fn send_one(&self, sub: &PushSub, payload: &[u8]) -> Result<u16, String> {
        let request = self.build_request(sub, payload)?;
        let (parts, body) = request.into_parts();
        let url = parts.uri.to_string();
        let mut req = self.client.post(&url);
        for (name, value) in parts.headers.iter() {
            req = req.header(name, value);
        }
        let resp = req.body(body).send().await.map_err(|e| e.to_string())?;
        Ok(resp.status().as_u16())
    }

    fn build_request(
        &self,
        sub: &PushSub,
        payload: &[u8],
    ) -> Result<http::Request<Vec<u8>>, String> {
        use p256::PublicKey;

        let key_pair = ES256KeyPair::from_bytes(&b64(&self.private_b64)?)
            .map_err(|e| format!("vapid key: {e}"))?;
        let endpoint: http::Uri = sub
            .endpoint
            .parse()
            .map_err(|e| format!("bad endpoint: {e}"))?;
        let public = PublicKey::from_sec1_bytes(&b64(&sub.p256dh)?)
            .map_err(|e| format!("bad p256dh: {e}"))?;
        let auth = Auth::clone_from_slice(&b64(&sub.auth)?);

        WebPushBuilder::new(endpoint, public, auth)
            .with_vapid(&key_pair, &self.subject)
            .build(payload.to_vec())
            .map_err(|e| format!("encrypt: {e}"))
    }
}

fn b64(s: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(s.trim())
        .map_err(|e| format!("base64: {e}"))
}

// Key precedence: explicit env override, else the persisted pair in the data
// dir, else a fresh keypair written there. Rotating the key invalidates every
// existing browser subscription, so it must be stable across restarts.
fn load_or_generate_keys(data_dir: &Path) -> (String, String) {
    if let (Ok(p), Ok(q)) = (
        std::env::var("BOITE_VAPID_PRIVATE_KEY"),
        std::env::var("BOITE_VAPID_PUBLIC_KEY"),
    ) {
        let p = p.trim().to_string();
        let q = q.trim().to_string();
        if !p.is_empty() && !q.is_empty() {
            return (p, q);
        }
    }

    let private_path = data_dir.join("vapid_private.key");
    let public_path = data_dir.join("vapid_public.key");
    if let (Ok(p), Ok(q)) = (
        fs::read_to_string(&private_path),
        fs::read_to_string(&public_path),
    ) {
        let p = p.trim().to_string();
        let q = q.trim().to_string();
        if !p.is_empty() && !q.is_empty() {
            return (p, q);
        }
    }

    let (private_b64, public_b64) = generate_keys();
    match fs::write(&private_path, &private_b64) {
        Ok(()) => set_key_permissions(&private_path),
        Err(e) => tracing::warn!("push: cannot persist VAPID private key: {e}"),
    }
    if let Err(e) = fs::write(&public_path, &public_b64) {
        tracing::warn!("push: cannot persist VAPID public key: {e}");
    }
    (private_b64, public_b64)
}

// VAPID private key = the raw 32-byte P-256 scalar, base64url (the form
// ES256KeyPair::from_bytes expects). Public key = the 65-byte uncompressed
// point, base64url (applicationServerKey).
fn generate_keys() -> (String, String) {
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    use p256::SecretKey;

    let secret = SecretKey::random(&mut rand::rngs::OsRng);
    let private_b64 = URL_SAFE_NO_PAD.encode(secret.to_bytes());
    let point = secret.public_key().to_encoded_point(false);
    let public_b64 = URL_SAFE_NO_PAD.encode(point.as_bytes());
    (private_b64, public_b64)
}

#[cfg(unix)]
fn set_key_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_key_permissions(_path: &Path) {}
