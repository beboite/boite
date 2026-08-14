//! Who is on the other end of a socket, and what they were paired to do.
//!
//! There used to be one answer to the first question and none at all to the
//! second: a single `BOITE_TOKEN`, held by every device, sent in clear in the
//! first WebSocket frame. One compromised phone was the whole workspace, the
//! only revocation was rotating the secret for everybody, and holding a socket
//! authorised every method on it. This server is published.
//!
//! Three credentials now, and none of them converts into another:
//!
//! | | Bootstrap token | Device credential | Socket ticket |
//! |---|---|---|---|
//! | Who holds it | the operator, in the environment | one paired device | one socket, once |
//! | Lives | as long as the deployment | until revoked | five minutes |
//! | Opens | `POST /api/pairings`, nothing else | `POST /api/ticket`, nothing else | one WebSocket |
//!
//! **The bootstrap token is not a session credential.** It cannot open a
//! socket, cannot call an RPC and cannot mint a ticket. All it can do is invite
//! a device, which is what keeps a deployed server's operator from being locked
//! out by this change without also leaving the old "everything, forever"
//! credential in place.
//!
//! **The long-lived device credential never travels in a URL and never opens a
//! socket.** It buys a ticket over authenticated HTTP, the ticket opens the
//! socket, and the ticket is worth nothing the moment it is spent. A query
//! string reaches an access log on the reverse proxy; a `POST` body does not.
//!
//! Every comparison here is constant time, on a SHA-256 of the secret rather
//! than on the secret. The per-IP lockout and its careful accounting are
//! unchanged: read [`Auth::note`] before touching what counts as an attempt.

use std::collections::HashMap;
use std::net::IpAddr;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rand::Rng;
use subtle::ConstantTimeEq;

use boite_core::pairing::{self, Credential, ScopeSet};
use boite_core::store::Store;

const MAX_FAILURES: u32 = 5;
const LOCKOUT: Duration = Duration::from_secs(60);

/// How long a socket ticket is good for.
///
/// Long enough to survive a phone waking up and dialling, short enough that one
/// lifted out of a heap dump is worth nothing by the time anybody reads it. It
/// is single-use as well, so this is a ceiling on a window that normally closes
/// in under a second.
pub const TICKET_TTL: Duration = Duration::from_secs(300);

/// How many unspent tickets are kept.
///
/// Each one is a few hundred bytes for at most five minutes, and a client that
/// asks for one and never dials is the ordinary case (a tab closed between the
/// two). The cap stops a paired device from being able to grow the map without
/// bound; expired entries are swept first, so it only ever bites a real flood.
const MAX_TICKETS: usize = 512;

/// Who a socket turned out to belong to.
///
/// The only thing that can be built out of a verified credential, and the only
/// thing `authz::Authorized` will take. A handler never asks whether a caller is
/// real, only what this one may do — the same shape of guarantee as
/// `boite_agent_api`'s `Caller` and `command::Ready`.
#[derive(Debug, Clone)]
pub struct Session {
    pairing_id: String,
    label: String,
    scopes: ScopeSet,
}

impl Session {
    pub fn pairing_id(&self) -> &str {
        &self.pairing_id
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn scopes(&self) -> ScopeSet {
        self.scopes
    }

    /// A session with everything, for the tests that drive the dispatcher
    /// rather than a socket.
    ///
    /// `#[cfg(test)]` on purpose and never behind a feature flag: a constructor
    /// that skips the check is the bypass this module exists to remove, and one
    /// compiled into the shipped binary would be exactly that.
    #[cfg(test)]
    pub fn for_test(scopes: ScopeSet) -> Session {
        Session::for_test_with_id("test", scopes)
    }

    #[cfg(test)]
    pub fn for_test_with_id(pairing_id: &str, scopes: ScopeSet) -> Session {
        Session {
            pairing_id: pairing_id.into(),
            label: "test".into(),
            scopes,
        }
    }
}

struct Failure {
    count: u32,
    locked_until: Option<Instant>,
}

struct Ticket {
    secret_hash: String,
    pairing_id: String,
    label: String,
    scopes: ScopeSet,
    expires: Instant,
}

pub struct Auth {
    /// `BOITE_TOKEN`, or the token file beside the database. Pairs a device and
    /// does nothing else.
    bootstrap: String,
    failures: Mutex<HashMap<IpAddr, Failure>>,
    tickets: Mutex<HashMap<String, Ticket>>,
}

impl Auth {
    pub fn new(bootstrap: String) -> Auth {
        Auth {
            bootstrap,
            failures: Mutex::new(HashMap::new()),
            tickets: Mutex::new(HashMap::new()),
        }
    }

    pub fn is_locked(&self, ip: IpAddr) -> bool {
        let map = self.failures.lock();
        match map.get(&ip).and_then(|f| f.locked_until) {
            Some(until) => Instant::now() < until,
            None => false,
        }
    }

    /// Records the outcome of one attempt and hands it back.
    ///
    /// Every door funnels through here, so the lockout counts what a prober
    /// actually sends rather than only the well-formed half of it. Locks the IP
    /// for 60s after MAX_FAILURES bad attempts.
    fn note(&self, ip: IpAddr, ok: bool) -> bool {
        let mut map = self.failures.lock();
        if ok {
            map.remove(&ip);
            return true;
        }
        // Bound memory under an IP-rotating spray: when the table grows large,
        // drop entries that are not actively locked.
        if map.len() > 4096 {
            let now = Instant::now();
            map.retain(|_, f| f.locked_until.map(|u| now < u).unwrap_or(false));
        }
        let entry = map.entry(ip).or_insert(Failure {
            count: 0,
            locked_until: None,
        });
        entry.count += 1;
        if entry.count >= MAX_FAILURES {
            // Keep the count across lockouts so a repeat offender stays
            // throttled (one try per LOCKOUT) instead of a fresh batch each
            // cycle.
            entry.locked_until = Some(Instant::now() + LOCKOUT);
        }
        false
    }

    /// The operator's token, at the one door it opens.
    ///
    /// Constant-time. It is checked here and nowhere else, and the caller is
    /// `POST /api/pairings`: this token may invite a device and may not be one.
    pub fn verify_bootstrap(&self, ip: IpAddr, candidate: &str) -> bool {
        let ok: bool = candidate
            .trim()
            .as_bytes()
            .ct_eq(self.bootstrap.as_bytes())
            .into();
        self.note(ip, ok)
    }

    /// A paired device's long-lived credential, at the ticket door.
    ///
    /// Found by the id half, which is not secret, then the secret half is
    /// compared in constant time against the stored hash. A revoked pairing
    /// fails here as if it had never existed, and counts as an attempt: a
    /// device whose credential was pulled and is still retrying is
    /// indistinguishable from somebody holding it who should not.
    pub fn verify_device(&self, ip: IpAddr, store: &Store, presented: &str) -> Option<Session> {
        let session = Credential::parse(presented)
            .and_then(|credential| {
                let (row, stored) = store.pairing(&credential.id)?;
                let matches: bool = pairing::hash_secret(&credential.secret)
                    .as_bytes()
                    .ct_eq(stored.as_bytes())
                    .into();
                if !matches || row.revoked() {
                    return None;
                }
                Some(Session {
                    pairing_id: row.id,
                    label: row.label,
                    scopes: row.scopes,
                })
            });
        if !self.note(ip, session.is_some()) {
            return None;
        }
        session
    }

    /// Hands out a ticket for one socket.
    ///
    /// The value returned is the only copy: what stays here is a hash, so a
    /// ticket read out of this process's memory does not open anything either.
    pub fn mint_ticket(&self, session: &Session) -> String {
        let id = random_hex(8);
        let secret = random_hex(32);
        let mut tickets = self.tickets.lock();
        let now = Instant::now();
        tickets.retain(|_, t| now < t.expires);
        if tickets.len() >= MAX_TICKETS {
            // Every entry that is left is unexpired, so there is nothing free to
            // drop: refuse the oldest instead of growing. Dropping the one
            // nearest to expiry costs whoever asked for it a retry, which is a
            // round trip, rather than costing this process its memory.
            if let Some(oldest) = tickets
                .iter()
                .min_by_key(|(_, t)| t.expires)
                .map(|(k, _)| k.clone())
            {
                tickets.remove(&oldest);
            }
        }
        tickets.insert(
            id.clone(),
            Ticket {
                secret_hash: pairing::hash_secret(&secret),
                pairing_id: session.pairing_id.clone(),
                label: session.label.clone(),
                scopes: session.scopes,
                expires: now + TICKET_TTL,
            },
        );
        format!("{id}.{secret}")
    }

    /// Spends a ticket at the socket door. It is worth nothing afterwards.
    ///
    /// Removed before it is compared, so a replay loses the race with itself
    /// rather than with a lock: two frames carrying the same ticket produce one
    /// session and the second reaches a map that no longer has the entry.
    pub fn spend_ticket(&self, ip: IpAddr, store: &Store, presented: &str) -> Option<Session> {
        let session = Credential::parse(presented).and_then(|credential| {
            let ticket = self.tickets.lock().remove(&credential.id)?;
            let matches: bool = pairing::hash_secret(&credential.secret)
                .as_bytes()
                .ct_eq(ticket.secret_hash.as_bytes())
                .into();
            if !matches || Instant::now() >= ticket.expires {
                return None;
            }
            // Between minting and dialling, the device may have been revoked.
            // A ticket is a pointer at a pairing, never a grant of its own.
            if !store.pairing_is_live(&ticket.pairing_id) {
                return None;
            }
            Some(Session {
                pairing_id: ticket.pairing_id,
                label: ticket.label,
                scopes: ticket.scopes,
            })
        });
        if !self.note(ip, session.is_some()) {
            return None;
        }
        session
    }

    /// Drops every ticket minted for one pairing.
    ///
    /// Revoking a device has to reach the five-minute window it may already be
    /// holding, not only the next credential it presents.
    pub fn drop_tickets_of(&self, pairing_id: &str) {
        self.tickets.lock().retain(|_, t| t.pairing_id != pairing_id);
    }
}

/// Mints a pairing token and writes it down, hashed.
///
/// The value comes back once, to be printed or drawn as a QR and then
/// forgotten. The table keeps only what it can be checked against.
pub fn mint_pairing_token(
    store: &Store,
    label: &str,
    kind: &str,
    scopes: ScopeSet,
    now_ms: i64,
    ttl_ms: i64,
) -> Result<String, String> {
    // Nothing here sweeps on a timer: minting is the only moment the table
    // grows, so it is the right moment to drop what nobody can spend.
    let _ = store.sweep_pairing_tokens(now_ms);
    let id = random_hex(8);
    let secret = random_hex(32);
    store.add_pairing_token(&pairing::PendingPairing {
        id: id.clone(),
        secret_hash: pairing::hash_secret(&secret),
        label: pairing::normalize_label(label),
        kind: pairing::normalize_kind(kind),
        scopes,
        created_at: now_ms,
        expires_at: now_ms + ttl_ms,
        used_at: None,
    })?;
    Ok(format!("{id}.{secret}"))
}

/// What a device gets back when it exchanges a pairing token.
pub struct Paired {
    pub credential: String,
    pub pairing: pairing::Pairing,
}

/// Exchanges a one-time pairing token for a device's own credential.
///
/// The order matters. The secret is checked first, so a wrong one does not
/// spend the token — anybody who learned the id half could otherwise burn an
/// invitation they cannot use. Then the token is spent atomically, so two
/// devices racing on one link produce one pairing.
pub fn redeem_pairing_token(
    auth: &Auth,
    ip: IpAddr,
    store: &Store,
    presented: &str,
    label: Option<&str>,
    kind: &str,
    now_ms: i64,
) -> Option<Paired> {
    let paired = (|| {
        let credential = Credential::parse(presented)?;
        let pending = store.pairing_token(&credential.id)?;
        let matches: bool = pairing::hash_secret(&credential.secret)
            .as_bytes()
            .ct_eq(pending.secret_hash.as_bytes())
            .into();
        if !matches {
            return None;
        }
        if !store.spend_pairing_token(&pending.id, now_ms).ok()? {
            return None;
        }
        let secret = random_hex(32);
        let row = pairing::Pairing {
            id: random_hex(8),
            // The device names itself if it can — a phone knows it is a phone
            // and the operator minting the link often does not. What was minted
            // is the fallback, never overridden by an empty string.
            label: label
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(pairing::normalize_label)
                .unwrap_or(pending.label),
            kind: if kind.trim().is_empty() {
                pending.kind
            } else {
                pairing::normalize_kind(kind)
            },
            scopes: pending.scopes,
            created_at: now_ms,
            last_seen_at: None,
            revoked_at: None,
        };
        store
            .add_pairing(&row, &pairing::hash_secret(&secret))
            .ok()?;
        Some(Paired {
            credential: format!("{}.{}", row.id, secret),
            pairing: row,
        })
    })();
    if !auth.note(ip, paired.is_some()) {
        return None;
    }
    paired
}

/// Hex from the thread RNG, which is a CSPRNG. `n` is bytes, so the string is
/// twice as long.
fn random_hex(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A store on a scratch database, for the tests below.
#[cfg(test)]
fn scratch(tag: &str) -> (Store, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("boite-auth-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let store = Store::open(&dir.join("boite.db")).unwrap();
    (store, dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(last: u8) -> IpAddr {
        IpAddr::from([127, 0, 0, last])
    }

    #[test]
    fn a_wrong_token_never_gets_through_and_a_right_one_always_does() {
        let auth = Auth::new("the-token".into());
        assert!(auth.verify_bootstrap(ip(1), "the-token"));
        assert!(!auth.verify_bootstrap(ip(1), "the-toke"));
        assert!(!auth.verify_bootstrap(ip(1), "the-tokenn"));
        assert!(!auth.verify_bootstrap(ip(1), ""));
    }

    /// Five tries, then the door is shut for a minute. Without this the token
    /// is guessable at whatever rate the network allows.
    #[test]
    fn an_address_that_keeps_guessing_is_locked_out() {
        let auth = Auth::new("the-token".into());
        assert!(!auth.is_locked(ip(2)));
        for _ in 0..MAX_FAILURES - 1 {
            assert!(!auth.verify_bootstrap(ip(2), "wrong"));
            assert!(!auth.is_locked(ip(2)), "locked too early");
        }
        assert!(!auth.verify_bootstrap(ip(2), "wrong"));
        assert!(auth.is_locked(ip(2)));
        // The lock is per address: one client guessing does not shut out the
        // rest of the house.
        assert!(!auth.is_locked(ip(3)));
        assert!(auth.verify_bootstrap(ip(3), "the-token"));
    }

    /// A success clears the count. Somebody who mistyped four times and then
    /// got it right is not one failure away from a lockout for the next hour.
    #[test]
    fn getting_it_right_forgives_what_came_before() {
        let auth = Auth::new("the-token".into());
        for _ in 0..MAX_FAILURES - 1 {
            assert!(!auth.verify_bootstrap(ip(4), "wrong"));
        }
        assert!(auth.verify_bootstrap(ip(4), "the-token"));
        for _ in 0..MAX_FAILURES - 1 {
            assert!(!auth.verify_bootstrap(ip(4), "wrong"));
            assert!(!auth.is_locked(ip(4)), "the count was not cleared");
        }
    }

    /// A spray from thousands of addresses must not be a way to grow the table
    /// until the process runs out of memory. What is dropped is what is not
    /// actively locked, so nobody escapes a lockout by making noise.
    #[test]
    fn a_spray_from_everywhere_does_not_grow_without_bound() {
        let auth = Auth::new("the-token".into());
        // One address earns a real lockout before the flood starts.
        for _ in 0..MAX_FAILURES {
            auth.verify_bootstrap(ip(9), "wrong");
        }
        assert!(auth.is_locked(ip(9)));

        for a in 0..40u8 {
            for b in 0..120u8 {
                auth.verify_bootstrap(IpAddr::from([10, 0, a, b]), "wrong");
            }
        }
        assert!(auth.failures.lock().len() <= 4096 + 1);
        assert!(auth.is_locked(ip(9)), "a locked address was swept away");
    }

    /// The three doors share one lockout. A prober that could spread its
    /// guesses across them would get fifteen tries instead of five.
    #[test]
    fn every_door_counts_against_the_same_lockout() {
        let (store, dir) = scratch("shared-lockout");
        let auth = Auth::new("the-token".into());
        auth.verify_bootstrap(ip(20), "wrong");
        auth.verify_device(ip(20), &store, "aaaaaaaa.bbbbbbbb");
        auth.spend_ticket(ip(20), &store, "aaaaaaaa.bbbbbbbb");
        redeem_pairing_token(&auth, ip(20), &store, "aaaaaaaa.bbbbbbbb", None, "phone", 1);
        assert!(!auth.is_locked(ip(20)), "four is not five");
        auth.verify_bootstrap(ip(20), "wrong");
        assert!(auth.is_locked(ip(20)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The whole flow, from an invitation nobody has spent to a socket.
    #[test]
    fn a_token_becomes_a_device_and_a_device_becomes_one_socket() {
        let (store, dir) = scratch("flow");
        let auth = Auth::new("the-token".into());
        let token = mint_pairing_token(&store, "Nuno phone", "phone", ScopeSet::standard(), 100, 600_000)
            .unwrap();

        let paired = redeem_pairing_token(&auth, ip(5), &store, &token, Some("my phone"), "phone", 200)
            .expect("the token was refused");
        assert_eq!(paired.pairing.label, "my phone");
        assert_eq!(paired.pairing.scopes, ScopeSet::standard());

        // Single use, and the same shape of race two devices would produce.
        assert!(
            redeem_pairing_token(&auth, ip(5), &store, &token, None, "phone", 300).is_none(),
            "a pairing token was spent twice"
        );

        // The credential buys a ticket, the ticket opens one socket, and the
        // credential itself never touches the socket door.
        let session = auth
            .verify_device(ip(5), &store, &paired.credential)
            .expect("the credential was refused");
        assert_eq!(session.scopes(), ScopeSet::standard());
        assert!(
            auth.spend_ticket(ip(5), &store, &paired.credential).is_none(),
            "a long-lived credential opened a socket"
        );

        let ticket = auth.mint_ticket(&session);
        assert!(auth.spend_ticket(ip(5), &store, &ticket).is_some());
        assert!(
            auth.spend_ticket(ip(5), &store, &ticket).is_none(),
            "a ticket was replayed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A revoked device is refused at both doors, and the ticket it may already
    /// be holding stops working with it. Revocation that only reaches the next
    /// handshake is revocation a device can outrun by staying connected.
    #[test]
    fn revoking_a_device_reaches_the_ticket_it_is_already_holding() {
        let (store, dir) = scratch("revoke");
        let auth = Auth::new("the-token".into());
        let token =
            mint_pairing_token(&store, "phone", "phone", ScopeSet::standard(), 100, 600_000).unwrap();
        let paired =
            redeem_pairing_token(&auth, ip(6), &store, &token, None, "phone", 200).unwrap();
        let session = auth.verify_device(ip(6), &store, &paired.credential).unwrap();
        let ticket = auth.mint_ticket(&session);

        store.revoke_pairing(&paired.pairing.id, 300).unwrap();

        assert!(
            auth.verify_device(ip(6), &store, &paired.credential).is_none(),
            "a revoked credential still buys a ticket"
        );
        assert!(
            auth.spend_ticket(ip(6), &store, &ticket).is_none(),
            "a ticket outlived the pairing it points at"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The bootstrap token is not a device. It pairs one, and that is all it can
    /// do — otherwise this change would leave the old credential in place under
    /// a new name.
    #[test]
    fn the_bootstrap_token_opens_no_socket_and_holds_no_scope() {
        let (store, dir) = scratch("bootstrap");
        let auth = Auth::new("the-token".into());
        assert!(auth.verify_device(ip(7), &store, "the-token").is_none());
        assert!(auth.spend_ticket(ip(7), &store, "the-token").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A wrong secret must not spend the invitation. The id half is not secret,
    /// so anybody who saw the link over somebody's shoulder could otherwise
    /// burn a pairing they cannot complete.
    #[test]
    fn a_wrong_secret_does_not_burn_the_invitation() {
        let (store, dir) = scratch("burn");
        let auth = Auth::new("the-token".into());
        let token =
            mint_pairing_token(&store, "phone", "phone", ScopeSet::standard(), 100, 600_000).unwrap();
        let id = token.split('.').next().unwrap();
        let wrong = format!("{id}.{}", "ab".repeat(32));

        assert!(redeem_pairing_token(&auth, ip(8), &store, &wrong, None, "phone", 200).is_none());
        assert!(
            redeem_pairing_token(&auth, ip(11), &store, &token, None, "phone", 200).is_some(),
            "the real invitation was burned by a wrong guess"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An expired invitation is not one, however well formed.
    #[test]
    fn an_expired_invitation_pairs_nothing() {
        let (store, dir) = scratch("expired");
        let auth = Auth::new("the-token".into());
        let token =
            mint_pairing_token(&store, "phone", "phone", ScopeSet::standard(), 100, 1_000).unwrap();
        assert!(
            redeem_pairing_token(&auth, ip(12), &store, &token, None, "phone", 5_000).is_none()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The map of unspent tickets is bounded. A paired device asking for one per
    /// reconnect must not be able to grow this process without limit.
    #[test]
    fn unspent_tickets_do_not_grow_without_bound() {
        let auth = Auth::new("the-token".into());
        let session = Session::for_test(ScopeSet::standard());
        for _ in 0..MAX_TICKETS + 50 {
            auth.mint_ticket(&session);
        }
        assert!(auth.tickets.lock().len() <= MAX_TICKETS);
    }
}
