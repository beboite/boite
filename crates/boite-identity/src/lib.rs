//! Who a request is from, proved rather than presented.
//!
//! Until this crate existed, every agent in a workspace held the same bearer
//! token. It proved the caller came from Boite and nothing else: a thread id in
//! a header said which project to answer for, and that header was a string the
//! caller chose. Any agent could read the header of any other, and any agent
//! could edit its own.
//!
//! Two credentials replace it, and neither can be turned into the other.
//!
//! **A thread key.** Boite spawns the terminal, so it mints a keypair for it
//! first: the public half goes on the thread's row and never moves again, the
//! private half is written to a file only that user can read and named in the
//! child's environment. The agent signs each request. Nothing reusable travels
//! over the wire, so a request captured in a log or a proxy is worth nothing,
//! and a thread cannot speak for another because it does not hold its key.
//!
//! **A project token.** For agents Boite cannot hand anything at launch, which
//! reach it through a credentials file instead. Derived from the workspace
//! secret and the project id, so the file written for one project does not open
//! another: editing the id in it produces a token that no longer verifies.
//!
//! Replay inside the freshness window is possible and deliberately not defended
//! against. The endpoint binds to loopback, the key file is mode 0600, and the
//! attacker who can capture a request on that socket can read the file it was
//! signed with. A nonce ledger would buy nothing and would need to be kept.
//!
//! This crate is separate from `boite-core` for one reason: the shim signs with
//! it and cannot afford to link sqlite, a PTY layer and a git driver to do it.

use ed25519_compact::{KeyPair, PublicKey, Seed, Signature};
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

/// Named in the signed string, so a future scheme cannot be confused with this
/// one by a verifier that accepts both.
pub const PROTOCOL: &str = "boite-v1";

/// How far a request's timestamp may be from the verifier's clock.
///
/// Both ends are the same machine, so this is not clock skew in the network
/// sense: it is how long a signed request stays usable, and two minutes is
/// enough for a shim that waits on `git` before it sends.
pub const FRESHNESS_MS: i64 = 120_000;

/// Header names, spelled once. The shim writes them and the endpoint reads
/// them, and the two used to be two string literals in two crates.
pub mod header {
    /// The thread the caller is, as an id.
    pub const THREAD: &str = "x-boite-thread";
    /// When the request was signed, in milliseconds since the epoch.
    pub const TIMESTAMP: &str = "x-boite-ts";
    /// The signature over [`super::canonical`], hex.
    pub const SIGNATURE: &str = "x-boite-sig";
    /// The project a credentials-file caller was issued for.
    pub const PROJECT: &str = "x-boite-project";
    /// Which agent is speaking, for the badge on a claim. Grants nothing.
    pub const AGENT: &str = "x-boite-agent";
}

/// What Boite stamps into a terminal it spawns.
///
/// Spelled here because two crates write these and one reads them: the desktop,
/// the server, and the shim. They used to be three string literals in three
/// files, and `BOITE_TOKEN` is what happens then — it outlived the thing it
/// named by a release.
pub mod env {
    /// Where the agent endpoint is listening. Always loopback.
    pub const URL: &str = "BOITE_MCP_URL";
    /// A file holding this thread's private key, hex, mode 0600.
    ///
    /// The path, never the value. `BOITE_TOKEN` carried the secret itself, so
    /// an agent typing `env` printed its own credential into a scrollback that
    /// is kept and replayed, and everything it launched inherited it.
    pub const KEY_FILE: &str = "BOITE_KEY_FILE";
    /// Which thread this terminal is. Not a credential on its own.
    pub const THREAD: &str = "BOITE_THREAD_ID";
    /// The role the thread's row carries, today only `orchestrator`.
    ///
    /// A hint for the shim's tool list, never an authority: every privileged
    /// call is re-checked against the row itself, so a process exporting this
    /// by hand gets a longer menu of refusals and nothing else.
    pub const ROLE: &str = "BOITE_ROLE";
    /// The scope of an orchestrator thread: a project id, or unset for the
    /// whole workspace. Same trust rules as [`ROLE`].
    pub const ORCHESTRATOR_SCOPE: &str = "BOITE_ORCHESTRATOR_SCOPE";
    /// The autonomy the user chose: `observer`, `dispatcher` or `autopilot`.
    /// Read by the orchestrator's own prompt; enforcement lives server-side.
    pub const AUTONOMY: &str = "BOITE_AUTONOMY";
}

/// The private half of a thread's identity.
///
/// Held by exactly one process: the agent's shim, which reads it from the file
/// Boite wrote at spawn. Boite itself keeps only the public half.
pub struct ThreadKey {
    pair: KeyPair,
}

impl ThreadKey {
    /// A new identity, for a thread being spawned.
    pub fn mint() -> ThreadKey {
        ThreadKey {
            pair: KeyPair::from_seed(Seed::generate()),
        }
    }

    /// Reads back what [`ThreadKey::seed_hex`] wrote.
    ///
    /// Whitespace-tolerant: the file is written by one process and read by
    /// another through a shell environment, and a trailing newline is not a
    /// broken credential.
    pub fn from_seed_hex(text: &str) -> Result<ThreadKey, String> {
        let raw = hex::decode(text.trim()).map_err(|_| "thread key is not hex".to_string())?;
        let seed = Seed::from_slice(&raw).map_err(|_| "thread key is the wrong size".to_string())?;
        Ok(ThreadKey {
            pair: KeyPair::from_seed(seed),
        })
    }

    /// What goes in the key file. Thirty-two bytes, hex.
    pub fn seed_hex(&self) -> String {
        hex::encode(self.pair.sk.seed().as_ref())
    }

    /// What goes on the thread's row. Thirty-two bytes, hex.
    pub fn public_hex(&self) -> String {
        hex::encode(self.pair.pk.as_ref())
    }

    pub fn sign(&self, message: &str) -> String {
        hex::encode(self.pair.sk.sign(message.as_bytes(), None).as_ref())
    }
}

/// The exact bytes both sides sign and verify.
///
/// One function rather than a format string on each side, because a signature
/// scheme where the two ends disagree about a separator fails as "invalid
/// signature", which reads like a wrong key and sends whoever is debugging it
/// to the wrong file.
///
/// The body is hashed in rather than appended: the endpoint reads it as bytes
/// and re-serialising it to compare would make the signature depend on how
/// serde orders a map.
pub fn canonical(method: &str, path: &str, thread_id: &str, ts_ms: i64, body: &[u8]) -> String {
    format!(
        "{PROTOCOL}\n{}\n{path}\n{thread_id}\n{ts_ms}\n{}",
        method.to_ascii_uppercase(),
        hex::encode(Sha256::digest(body))
    )
}

/// Whether this signature was made by the holder of that public key.
///
/// Every failure is the same `false`: a malformed key, a malformed signature
/// and a wrong one are all "this caller is not who it says", and telling them
/// apart in the answer only helps whoever is probing.
pub fn verify(public_hex: &str, message: &str, signature_hex: &str) -> bool {
    let Ok(key) = hex::decode(public_hex.trim()) else {
        return false;
    };
    let Ok(sig) = hex::decode(signature_hex.trim()) else {
        return false;
    };
    let (Ok(key), Ok(sig)) = (PublicKey::from_slice(&key), Signature::from_slice(&sig)) else {
        return false;
    };
    key.verify(message.as_bytes(), &sig).is_ok()
}

/// Whether a signed request is recent enough to act on.
///
/// Symmetric, so a shim whose clock runs slightly ahead is not locked out of
/// its own workspace.
pub fn fresh(ts_ms: i64, now_ms: i64) -> bool {
    (now_ms - ts_ms).abs() <= FRESHNESS_MS
}

/// The token written into one project's credentials file.
///
/// Derived rather than stored: there is nothing to keep in step, nothing extra
/// to leak, and a workspace secret that dies with the process takes every
/// derived token with it. Editing the project id in a credentials file produces
/// a token this no longer agrees with, which is the whole point of it.
pub fn project_token(secret: &str, project_id: &str) -> String {
    let mut mac = <Hmac<Sha256>>::new_from_slice(secret.as_bytes())
        .expect("hmac accepts a key of any length");
    mac.update(project_id.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signature_verifies_against_its_own_public_half() {
        let key = ThreadKey::mint();
        let message = canonical("post", "/v1/todos", "t1", 1_700_000_000_000, b"{}");
        let sig = key.sign(&message);
        assert!(verify(&key.public_hex(), &message, &sig));
    }

    /// The property the whole crate exists for: one thread cannot speak for
    /// another, because it does not hold the other's key.
    #[test]
    fn another_threads_key_does_not_open_this_one() {
        let mine = ThreadKey::mint();
        let theirs = ThreadKey::mint();
        let message = canonical("POST", "/v1/todos", "t1", 1, b"");
        assert!(!verify(&mine.public_hex(), &message, &theirs.sign(&message)));
    }

    /// Every part of the request is covered. A signature lifted off one call
    /// must not authorise a different one.
    #[test]
    fn nothing_signed_can_be_swapped_afterwards() {
        let key = ThreadKey::mint();
        let base = canonical("POST", "/v1/todos", "t1", 100, b"{\"title\":\"a\"}");
        let sig = key.sign(&base);
        let pk = key.public_hex();
        for other in [
            canonical("GET", "/v1/todos", "t1", 100, b"{\"title\":\"a\"}"),
            canonical("POST", "/v1/threads", "t1", 100, b"{\"title\":\"a\"}"),
            canonical("POST", "/v1/todos", "t2", 100, b"{\"title\":\"a\"}"),
            canonical("POST", "/v1/todos", "t1", 101, b"{\"title\":\"a\"}"),
            canonical("POST", "/v1/todos", "t1", 100, b"{\"title\":\"b\"}"),
        ] {
            assert!(!verify(&pk, &other, &sig), "{other}");
        }
    }

    /// The method is normalised, so a shim sending `post` and an endpoint
    /// reading `POST` are not a debugging session.
    #[test]
    fn the_method_is_compared_in_one_case() {
        assert_eq!(
            canonical("post", "/a", "t", 1, b""),
            canonical("POST", "/a", "t", 1, b"")
        );
    }

    #[test]
    fn a_key_survives_the_round_trip_through_its_file() {
        let key = ThreadKey::mint();
        let reread = ThreadKey::from_seed_hex(&format!("  {}\n", key.seed_hex())).unwrap();
        assert_eq!(reread.public_hex(), key.public_hex());
        let message = canonical("GET", "/v1/todos", "t1", 5, b"");
        assert!(verify(&key.public_hex(), &message, &reread.sign(&message)));
    }

    #[test]
    fn a_broken_credential_is_refused_rather_than_panicking() {
        assert!(ThreadKey::from_seed_hex("not hex").is_err());
        assert!(ThreadKey::from_seed_hex("aabb").is_err());
        assert!(!verify("zz", "m", "zz"));
        assert!(!verify("aabb", "m", "aabb"));
    }

    #[test]
    fn a_stale_or_early_timestamp_is_refused() {
        let now = 1_700_000_000_000;
        assert!(fresh(now, now));
        assert!(fresh(now - FRESHNESS_MS, now));
        assert!(fresh(now + FRESHNESS_MS, now));
        assert!(!fresh(now - FRESHNESS_MS - 1, now));
        assert!(!fresh(now + FRESHNESS_MS + 1, now));
    }

    /// A credentials file names the project it was issued for. Changing that id
    /// is what used to reach another project's list.
    #[test]
    fn a_project_token_only_opens_its_own_project() {
        let a = project_token("s3cret", "project-a");
        let b = project_token("s3cret", "project-b");
        assert_ne!(a, b);
        assert_eq!(a, project_token("s3cret", "project-a"));
        // And a different workspace secret produces a different token for the
        // same project, so a file kept from a previous run opens nothing.
        assert_ne!(a, project_token("other", "project-a"));
    }
}
