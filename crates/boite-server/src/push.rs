use std::fs;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use web_push_native::jwt_simple::algorithms::ES256KeyPair;
use web_push_native::{Auth, WebPushBuilder};

use boite_core::awareness::Awareness;
use boite_core::store::{PushSub, Store};

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
            client: build_client(SEND_TIMEOUT),
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
    ///
    /// The payload carries the awareness value's own `link`, as a path rather
    /// than a URL: the service worker resolves it against the origin it was
    /// served from, which is the only origin that can answer for this workspace.
    /// An absolute one built here would be whatever `BOITE_PUBLIC_URL` says,
    /// which is right for a webhook and wrong for a browser that reached the
    /// server some other way.
    pub async fn notify_all(&self, store: &Store, a: &Awareness) {
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
        let payload = serde_json::json!({
            "title": a.headline,
            "body": a.detail,
            // One notification per thread rather than per event: a thread that
            // starts, finishes and asks a question inside a minute replaces its
            // own bubble instead of stacking three.
            "tag": format!("boite:{}", a.thread_id),
            "url": a.link,
            "phase": a.phase,
            "threadId": a.thread_id,
        })
        .to_string();
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
        // Checked again here, not only where the row was registered. Between the
        // two sits a database an older build wrote under looser rules, a restore
        // from a backup, and any other process holding that file open. The check
        // that decides whether a request leaves this host belongs next to the
        // send, and it costs a URI parse.
        acceptable_endpoint(&sub.endpoint)?;
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

/// How long a push service gets to answer a POST.
///
/// A real one answers in well under a second. Anything past this is a host that
/// accepted the connection and stopped talking, and `notify_all` walks its
/// subscriptions in sequence: one such host with no bound stalls every
/// notification behind it, for as long as it feels like stalling.
const SEND_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the connect itself gets, inside the budget above. Separate because a
/// TCP handshake that hangs is the cheap half of the same attack: an address
/// that blackholes SYNs costs the sender nothing.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// The client every push POST goes through.
///
/// Three things about it are load-bearing, and none of them is the default:
///
/// * **No redirects.** `acceptable_endpoint` judges the URL the client hands
///   over; a 302 replaces it with one nobody judged. Following one is how a
///   registered `https://push.attacker.example/x` becomes a GET on
///   `http://169.254.169.254/`, past every check above. No push service redirects
///   a POST, so refusing costs nothing. A 3xx comes back as a 3xx and is logged
///   like any other unexpected status.
/// * **Public addresses only.** A hostname is not an address, so the check at
///   registration cannot see where the name points, and re-resolving it before
///   the send would only move the race. The resolver here is the one the
///   connection actually uses: hyper connects to exactly the addresses it hands
///   back and resolves nothing a second time, so filtering there is the pin.
/// * **Bounded in time**, as above.
fn build_client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .connect_timeout(CONNECT_TIMEOUT)
        // Nothing here follows a link, and a Referer on a push POST only tells a
        // push service where this workspace lives.
        .referer(false)
        .dns_resolver(Arc::new(PublicOnlyDns))
        .build()
        // Only a TLS backend that will not initialise fails this, and a server
        // that cannot build one cannot serve either.
        .expect("push client")
}

/// A resolver that hands the connector public addresses and nothing else.
struct PublicOnlyDns;

impl reqwest::dns::Resolve for PublicOnlyDns {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            match resolve_public(&host).await {
                Ok(addrs) => Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs),
                Err(e) => Err(e.into()),
            }
        })
    }
}

/// Resolve a name, then drop every address that is not on the public internet.
///
/// A name that resolves only inward resolves to nothing here, which is a connect
/// error rather than a request to somewhere it should not go. `to_socket_addrs`
/// blocks, hence the blocking pool: the alternative is a DNS lookup stalling a
/// runtime worker thread that has PTY reads on it.
async fn resolve_public(host: &str) -> Result<Vec<SocketAddr>, String> {
    use std::net::ToSocketAddrs;

    let owned = host.to_string();
    let all = tokio::task::spawn_blocking(move || {
        // Port 0: reqwest puts the real one back on whatever comes out.
        (owned.as_str(), 0u16)
            .to_socket_addrs()
            .map(|addrs| addrs.collect::<Vec<SocketAddr>>())
    })
    .await
    .map_err(|e| format!("dns: {e}"))?
    .map_err(|e| format!("dns: {e}"))?;

    let public: Vec<SocketAddr> = all.into_iter().filter(|a| is_public_ip(a.ip())).collect();
    if public.is_empty() {
        return Err(format!(
            "`{host}` resolves nowhere on the public internet, so no push request is made to it"
        ));
    }
    Ok(public)
}

/// Hosts the workspace will accept a push endpoint on, when the operator has
/// named any.
///
/// Empty is the default and means the shape check below is the whole rule, which
/// is what a workspace whose users are on browsers nobody enumerated needs. An
/// operator who knows the answer sets `BOITE_PUSH_ALLOWED_HOSTS` to a
/// comma-separated list of hosts, and then only those and their subdomains are
/// registrable: `fcm.googleapis.com,push.services.mozilla.com,web.push.apple.com,notify.windows.com`
/// is the whole browser field as it stands. Read once, because it is process
/// configuration and re-reading the environment on every subscribe only buys a
/// way for it to change mid-run.
fn allowed_hosts() -> &'static [String] {
    static HOSTS: OnceLock<Vec<String>> = OnceLock::new();
    HOSTS.get_or_init(|| {
        std::env::var("BOITE_PUSH_ALLOWED_HOSTS")
            .unwrap_or_default()
            .split(',')
            .map(|h| h.trim().trim_matches('.').to_ascii_lowercase())
            .filter(|h| !h.is_empty())
            .collect()
    })
}

/// Whether a host is one of the allowed ones, or sits under it.
///
/// Suffix matching on a label boundary, so `evilfcm.googleapis.com` does not pass
/// for `fcm.googleapis.com` and neither does `fcm.googleapis.com.attacker.test`.
fn host_allowed(host: &str, allowed: &[String]) -> bool {
    if allowed.is_empty() {
        return true;
    }
    let host = host.trim_matches('.').to_ascii_lowercase();
    allowed
        .iter()
        .any(|a| host == *a || host.ends_with(&format!(".{a}")))
}

/// How many endpoints the workspace will ever hold.
///
/// Subscriptions are global and keyed by endpoint, so the honest case is one per
/// browser the user installed the PWA on. The cap is what stops a client that
/// can register one from registering a million.
pub const MAX_PUSH_SUBSCRIPTIONS: usize = 64;

/// Whether this is a push endpoint the server may be told to POST to.
///
/// The server fetches every stored endpoint on its own, without anybody asking,
/// so an unchecked one turns a client into an outbound request generator aimed
/// at whatever the server can reach: a metadata service, an admin port on the
/// host, a neighbour on the LAN. The token is not a defence here, since the main
/// server is bound to a routable interface on purpose in a remote workspace.
///
/// The shape of a real endpoint is narrow and every browser agrees on it: HTTPS,
/// a public host, the default port. Nothing legitimate is turned away by saying
/// exactly that.
///
/// This is the shape check and only the shape check. A name it lets through is
/// still a name, and where that name points is decided by [`PublicOnlyDns`] at
/// connect time, on the addresses the connection uses. The two together are the
/// rule; neither half is enough on its own, and this one is called again at send
/// so a row that predates it does not get a free pass.
pub fn acceptable_endpoint(endpoint: &str) -> Result<(), String> {
    let uri: http::Uri = endpoint.parse().map_err(|e| format!("bad endpoint: {e}"))?;
    if uri.scheme_str() != Some("https") {
        return Err("a push endpoint has to be https".into());
    }
    if !matches!(uri.port_u16(), None | Some(443)) {
        return Err("a push endpoint has to be on the default https port".into());
    }
    let host = uri.host().ok_or("a push endpoint has to name a host")?;
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if bare.eq_ignore_ascii_case("localhost") || bare.to_ascii_lowercase().ends_with(".localhost") {
        return Err("a push endpoint cannot point back at this machine".into());
    }
    // A name is left to DNS: rebinding it at send time is a different attack and
    // one this check could not win anyway. A literal is the reachable half, and
    // it is what an internal target is spelled with.
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        if !is_public_ip(ip) {
            return Err("a push endpoint cannot point inside the network".into());
        }
        // An address literal never reaches the resolver: hyper connects to it
        // directly. So a literal has to be judged here or nowhere, and an
        // allowlist of push hosts is a list of names, which a literal is not.
        if !allowed_hosts().is_empty() {
            return Err(
                "this workspace only takes push endpoints on the hosts it was given".into(),
            );
        }
    }
    if !host_allowed(bare, allowed_hosts()) {
        return Err("this workspace only takes push endpoints on the hosts it was given".into());
    }
    Ok(())
}

/// Whether an address literal is somewhere on the public internet rather than
/// somewhere only this host or this network can reach.
fn is_public_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                // 100.64.0.0/10, which is how a container reaches its host on
                // more than one hosting provider.
                || (a == 100 && (64..128).contains(&b)))
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(mapped));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // fc00::/7, unique local.
                || (first & 0xfe00) == 0xfc00
                // fe80::/10, link local.
                || (first & 0xffc0) == 0xfe80)
        }
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
    if let Err(e) = crate::secret_file::write(&private_path, &private_b64) {
        tracing::warn!("push: cannot persist VAPID private key: {e}");
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

    // p256's own `rand_core`, not this crate's `rand`. `SecretKey::random` takes
    // the RNG traits of the `rand_core` p256 was built against, and the `rand`
    // the rest of the server uses is several major versions ahead of it: passing
    // its OS RNG here does not typecheck, whatever it is called this year. Both
    // read the same system entropy source.
    let secret = SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
    let private_b64 = URL_SAFE_NO_PAD.encode(secret.to_bytes());
    let point = secret.public_key().to_encoded_point(false);
    let public_b64 = URL_SAFE_NO_PAD.encode(point.as_bytes());
    (private_b64, public_b64)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The endpoints a browser actually hands over, and the ones that turn the
    /// server into somebody's outbound request.
    #[test]
    fn only_a_public_https_endpoint_is_accepted() {
        let ok = |url: &str| acceptable_endpoint(url).is_ok();

        assert!(ok("https://fcm.googleapis.com/fcm/send/abc123"));
        assert!(ok(
            "https://updates.push.services.mozilla.com/wpush/v2/gAAA"
        ));
        assert!(ok("https://push.example.com:443/x"));

        // The cloud metadata service, the reason this check exists.
        assert!(!ok("http://169.254.169.254/latest/meta-data/"));
        assert!(!ok("https://169.254.169.254/latest/meta-data/"));
        // Back at the host itself, spelled every way it is spelled.
        assert!(!ok("https://127.0.0.1/x"));
        assert!(!ok("https://localhost/x"));
        assert!(!ok("https://anything.localhost/x"));
        assert!(!ok("https://[::1]/x"));
        assert!(!ok("https://[::ffff:127.0.0.1]/x"));
        // A neighbour on the LAN or in the container network.
        assert!(!ok("https://10.0.0.5/admin"));
        assert!(!ok("https://192.168.1.1/admin"));
        assert!(!ok("https://172.16.4.4/admin"));
        assert!(!ok("https://100.100.0.1/admin"));
        assert!(!ok("https://[fd00::1]/admin"));
        assert!(!ok("https://[fe80::1]/admin"));
        // Plain http, and an admin port behind a public name.
        assert!(!ok("http://push.example.com/x"));
        assert!(!ok("https://push.example.com:9200/_cluster/health"));
        assert!(!ok("not a url at all"));
    }

    /// The whole browser field, so a change to the shape check that quietly
    /// stopped taking one of these would be caught here rather than by a user
    /// whose notifications went silent.
    #[test]
    fn the_endpoints_browsers_actually_hand_over_are_kept() {
        for real in [
            "https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91b",
            "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABm",
            "https://web.push.apple.com/QLg3sM9ZgLzY",
            "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB",
            "https://push.example.com/selfhosted/aBc123",
        ] {
            assert!(acceptable_endpoint(real).is_ok(), "{real} was refused");
        }
    }

    /// An allowlist is a list of names, matched on a label boundary. The two
    /// misses are the ones a prefix or a plain `contains` would let through.
    #[test]
    fn an_allowlist_matches_only_on_a_label_boundary() {
        let allowed = vec![
            "fcm.googleapis.com".to_string(),
            "notify.windows.com".to_string(),
        ];
        assert!(host_allowed("fcm.googleapis.com", &allowed));
        assert!(host_allowed("FCM.GoogleAPIs.com", &allowed));
        assert!(host_allowed("wns2-par02p.notify.windows.com", &allowed));

        assert!(!host_allowed("evilfcm.googleapis.com", &allowed));
        assert!(!host_allowed("fcm.googleapis.com.attacker.test", &allowed));
        assert!(!host_allowed("updates.push.services.mozilla.com", &allowed));

        // Nothing configured is the default and takes everything the shape
        // check already agreed to.
        assert!(host_allowed("updates.push.services.mozilla.com", &[]));
    }

    /// The half `acceptable_endpoint` cannot decide: a name is not an address,
    /// and this is the resolver the connection itself uses, so what it refuses
    /// is never connected to. `localhost` is the one name that resolves inward
    /// on every machine without asking a network.
    #[tokio::test]
    async fn a_name_that_points_inward_resolves_to_nothing() {
        let err = resolve_public("localhost").await.unwrap_err();
        assert!(err.contains("public internet"), "{err}");
    }

    /// A 302 on a POST is not a push service, it is somebody moving the target
    /// after the check. The client returns the 302 and never fetches what it
    /// points at.
    #[tokio::test]
    async fn the_push_client_does_not_follow_a_redirect() {
        let inside = probe(Some(ok_response(200))).await;
        let front = probe(Some(format!(
            "HTTP/1.1 302 Found\r\nLocation: {}\r\nContent-Length: 0\r\n\r\n",
            inside.url("/latest/meta-data/")
        )))
        .await;

        let client = build_client(SEND_TIMEOUT);
        let status = client
            .post(front.url("/push"))
            .body(vec![7u8; 64])
            .send()
            .await
            .unwrap()
            .status()
            .as_u16();

        assert_eq!(status, 302, "the redirect was followed");
        assert_eq!(front.hits(), 1);
        assert_eq!(inside.hits(), 0, "the private target was fetched");
    }

    /// The same client on the ordinary path: a push service answers 201 and that
    /// is what comes back. Hardening that also broke sending would pass every
    /// test above and ship nothing working.
    #[tokio::test]
    async fn an_ordinary_push_response_still_comes_back() {
        let service = probe(Some(ok_response(201))).await;
        let client = build_client(SEND_TIMEOUT);
        let status = client
            .post(service.url("/wpush/v2/gAAA"))
            .body(vec![7u8; 64])
            .send()
            .await
            .unwrap()
            .status()
            .as_u16();
        assert_eq!(status, 201);
        assert_eq!(service.hits(), 1);
    }

    /// A host that accepts the connection and never speaks. Without a timeout
    /// this test hangs, which is what it is here to stop happening in
    /// `notify_all`.
    #[tokio::test]
    async fn a_send_gives_up_on_a_host_that_never_answers() {
        let mute = probe(None).await;
        let client = build_client(Duration::from_millis(250));
        let err = client
            .post(mute.url("/x"))
            .body(vec![7u8; 64])
            .send()
            .await
            .expect_err("a mute host answered");
        assert!(err.is_timeout(), "{err}");
    }

    /// A row already in the database gets the same check as a new one, before
    /// anything is connected to. The endpoint here is plain http on loopback,
    /// which is what a row written by a build without these rules looks like.
    ///
    /// The keys are real ones, so the endpoint is the only thing that can stop
    /// this: drop the check at the top of `send_one` and the encryption succeeds,
    /// the POST goes out and the probe below counts it.
    #[tokio::test]
    async fn a_stored_endpoint_is_judged_again_at_send() {
        let dir = std::env::temp_dir().join(format!("boite-push-send-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let manager = PushManager::load(&dir);

        let hidden = probe(Some(ok_response(201))).await;
        let sub = PushSub {
            endpoint: hidden.url("/x"),
            p256dh: a_browser_public_key(),
            auth: URL_SAFE_NO_PAD.encode([7u8; 16]),
        };

        let err = manager
            .send_one(&sub, b"{}")
            .await
            .expect_err("a stored endpoint was sent to unchecked");
        assert!(err.contains("https"), "{err}");
        assert_eq!(hidden.hits(), 0, "it was connected to before being judged");
        let _ = fs::remove_dir_all(&dir);
    }

    /// What a browser hands over as `keys.p256dh`: its own subscription public
    /// key, the 65-byte uncompressed point, base64url.
    fn a_browser_public_key() -> String {
        use p256::elliptic_curve::sec1::ToEncodedPoint;
        let secret = p256::SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
        URL_SAFE_NO_PAD.encode(secret.public_key().to_encoded_point(false).as_bytes())
    }

    // ---- a loopback HTTP server, so none of the above touches a network ----

    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct Probe {
        addr: SocketAddr,
        hits: Arc<AtomicUsize>,
    }

    impl Probe {
        fn url(&self, path: &str) -> String {
            format!("http://{}{path}", self.addr)
        }
        fn hits(&self) -> usize {
            self.hits.load(Ordering::SeqCst)
        }
    }

    fn ok_response(code: u16) -> String {
        format!("HTTP/1.1 {code} OK\r\nContent-Length: 0\r\n\r\n")
    }

    /// An HTTP server on loopback that counts what reaches it. `reply` is written
    /// back once the request has been read whole; `None` accepts the connection
    /// and says nothing.
    async fn probe(reply: Option<String>) -> Probe {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                counter.fetch_add(1, Ordering::SeqCst);
                let reply = reply.clone();
                tokio::spawn(async move {
                    // Drain the request before answering. A receive buffer still
                    // holding bytes when the socket closes is a reset, and the
                    // client reports that instead of the response.
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 1024];
                    loop {
                        if let Some(end) = header_end(&buf) {
                            if buf.len() >= end + content_length(&buf[..end]) {
                                break;
                            }
                        }
                        match sock.read(&mut chunk).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                    }
                    match reply {
                        Some(reply) => {
                            let _ = sock.write_all(reply.as_bytes()).await;
                            let _ = sock.flush().await;
                        }
                        // Hold it open with nothing on it, well past any timeout
                        // under test.
                        None => tokio::time::sleep(Duration::from_secs(30)).await,
                    }
                });
            }
        });
        Probe { addr, hits }
    }

    fn header_end(buf: &[u8]) -> Option<usize> {
        buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
    }

    fn content_length(head: &[u8]) -> usize {
        for line in String::from_utf8_lossy(head).lines() {
            let lower = line.to_ascii_lowercase();
            if let Some(value) = lower.strip_prefix("content-length:") {
                return value.trim().parse().unwrap_or(0);
            }
        }
        0
    }
}
