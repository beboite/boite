//! What a paired device may do, and how it proves it is that device.
//!
//! The agent door already answers "who is calling" with a credential that
//! belongs to one caller (`boite-agent-api`, `crate::capability`). The device
//! door did not: one workspace token, held by every phone and laptop, and
//! holding a socket authorised every method on it. This module is the device
//! half of the same idea.
//!
//! Two things live here and nothing else: the vocabulary of what a device may
//! ask for ([`Scope`], [`ScopeSet`]), and the shape of the credential it
//! presents ([`Credential`]). The comparison itself is `boite-server`'s, which
//! is where `subtle` lives; a secret is never compared with `==` anywhere.
//!
//! ## The credential is two halves on purpose
//!
//! `<id>.<secret>`. The id is not secret and is what the row is found by, so a
//! lookup is one indexed read rather than a scan comparing every stored secret
//! against the one presented. Only the second half is compared, in constant
//! time, against a SHA-256 of what was issued. The database therefore holds
//! nothing that can be replayed: a dump of `pairings` opens no socket.

use serde::de::{SeqAccess, Visitor};
use serde::ser::SerializeSeq;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use sha2::{Digest, Sha256};

/// What a device is allowed to ask for.
///
/// Five, and the count is a decision. `crate::capability` makes the same
/// argument for agents in three words: a permission list with one entry per
/// method is a list nobody reads and that every new command has to be added to
/// by hand. These five are the distinctions a device can actually be paired
/// along.
///
/// [`Scope::Read`], [`Scope::Write`] and [`Scope::Admin`] are the three
/// capabilities the command bus already declares per method, under the names a
/// device owner would use. The other two are the things a device does that no
/// bus command covers, and they are the reason this is not just [`Capability`]
/// re-exported: a terminal is not a project mutation, and answering for the
/// user is not one either.
///
/// [`Capability`]: crate::capability::Capability
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Scope {
    /// Look at the workspace: rows, git status, file contents, search, the
    /// timeline, the snapshot.
    Read,
    /// Change something inside a project: commit, write a file, save a todo,
    /// edit settings.
    Write,
    /// Open, drive, resize and kill a terminal. Independent of [`Scope::Write`]
    /// because a PTY is not a project mutation: it is arbitrary code on the
    /// machine, which is the one thing a read-only phone must not reach.
    Terminal,
    /// Answer what an agent put in front of the user, and volunteer to carry
    /// out what an agent asked for.
    Approve,
    /// Reach past a project or change what every other device sees: create or
    /// delete a project, delete a thread, and pair or revoke a device.
    Admin,
}

impl Scope {
    pub const ALL: [Scope; 5] = [
        Scope::Read,
        Scope::Write,
        Scope::Terminal,
        Scope::Approve,
        Scope::Admin,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Read => "read",
            Scope::Write => "write",
            Scope::Terminal => "terminal",
            Scope::Approve => "approve",
            Scope::Admin => "admin",
        }
    }

    pub fn parse(text: &str) -> Option<Scope> {
        Scope::ALL
            .into_iter()
            .find(|s| s.as_str().eq_ignore_ascii_case(text.trim()))
    }

    /// What a refusal says. A person reads this one, not an agent, so it names
    /// the thing that is missing and where to change it.
    pub fn refusal(self) -> String {
        format!(
            "this device is not paired for {}. Re-pair it, or grant the scope from the devices screen.",
            self.as_str()
        )
    }

    fn bit(self) -> u8 {
        match self {
            Scope::Read => 1,
            Scope::Write => 1 << 1,
            Scope::Terminal => 1 << 2,
            Scope::Approve => 1 << 3,
            Scope::Admin => 1 << 4,
        }
    }
}

/// What one pairing was granted.
///
/// Stored exactly as it was granted, and read with one implication applied:
/// `admin` covers `write` covers `read`. Nothing implies [`Scope::Terminal`] or
/// [`Scope::Approve`], because an implication there would hand out a PTY to
/// somebody who asked for the ability to rename a project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ScopeSet(u8);

impl ScopeSet {
    pub const fn empty() -> ScopeSet {
        ScopeSet(0)
    }

    /// Read, write, a terminal and the ability to answer: what a device the
    /// user actually works from is paired with.
    pub fn standard() -> ScopeSet {
        ScopeSet::empty()
            .with(Scope::Read)
            .with(Scope::Write)
            .with(Scope::Terminal)
            .with(Scope::Approve)
    }

    /// Everything, including pairing further devices.
    pub fn full() -> ScopeSet {
        ScopeSet::standard().with(Scope::Admin)
    }

    pub fn with(self, scope: Scope) -> ScopeSet {
        ScopeSet(self.0 | scope.bit())
    }

    pub fn without(self, scope: Scope) -> ScopeSet {
        ScopeSet(self.0 & !scope.bit())
    }

    /// Whether this scope was granted, with nothing read into it.
    pub fn holds(self, scope: Scope) -> bool {
        self.0 & scope.bit() != 0
    }

    /// Whether a call needing this scope may proceed.
    pub fn allows(self, scope: Scope) -> bool {
        match scope {
            Scope::Read => {
                self.holds(Scope::Read) || self.holds(Scope::Write) || self.holds(Scope::Admin)
            }
            Scope::Write => self.holds(Scope::Write) || self.holds(Scope::Admin),
            Scope::Terminal | Scope::Approve | Scope::Admin => self.holds(scope),
        }
    }

    pub fn ensure(self, scope: Scope) -> Result<(), String> {
        if self.allows(scope) {
            return Ok(());
        }
        Err(scope.refusal())
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// Every scope actually granted, in a stable order.
    pub fn names(self) -> Vec<&'static str> {
        Scope::ALL
            .into_iter()
            .filter(|s| self.holds(*s))
            .map(Scope::as_str)
            .collect()
    }

    /// How the row stores it. Comma-separated names rather than the bits: a
    /// column somebody can read in a `sqlite3` shell is worth more than four
    /// saved bytes, and a bit that shifts meaning between versions is a grant
    /// that silently changes.
    pub fn to_text(self) -> String {
        self.names().join(",")
    }

    /// Unknown names are dropped rather than refused. A row written by a newer
    /// Boite naming a scope this build has never heard of must not become a
    /// device that cannot connect at all; what it loses is the scope, which is
    /// the safe direction.
    pub fn parse(text: &str) -> ScopeSet {
        text.split(',')
            .filter_map(Scope::parse)
            .fold(ScopeSet::empty(), ScopeSet::with)
    }

    pub fn from_names<I, S>(names: I) -> ScopeSet
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        names
            .into_iter()
            .filter_map(|n| Scope::parse(n.as_ref()))
            .fold(ScopeSet::empty(), ScopeSet::with)
    }
}

impl Serialize for ScopeSet {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let names = self.names();
        let mut seq = serializer.serialize_seq(Some(names.len()))?;
        for name in names {
            seq.serialize_element(name)?;
        }
        seq.end()
    }
}

impl<'de> Deserialize<'de> for ScopeSet {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<ScopeSet, D::Error> {
        struct Names;
        impl<'de> Visitor<'de> for Names {
            type Value = ScopeSet;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a list of scope names")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<ScopeSet, A::Error> {
                let mut set = ScopeSet::empty();
                while let Some(name) = seq.next_element::<String>()? {
                    if let Some(scope) = Scope::parse(&name) {
                        set = set.with(scope);
                    }
                }
                Ok(set)
            }
            fn visit_str<E>(self, text: &str) -> Result<ScopeSet, E> {
                Ok(ScopeSet::parse(text))
            }
        }
        deserializer.deserialize_any(Names)
    }
}

/// What kind of thing is on the other end.
///
/// Cosmetic, and normalised to a known word so the list draws an icon rather
/// than whatever string a client sent. It is never read as authorisation.
pub fn normalize_kind(raw: &str) -> String {
    let kind = raw.trim().to_ascii_lowercase();
    match kind.as_str() {
        "desktop" | "phone" | "tablet" | "browser" | "cli" => kind,
        _ => "unknown".to_string(),
    }
}

pub const MAX_LABEL: usize = 64;

/// What the list shows for it. Capped rather than refused: it is text on a row,
/// not a value anything parses.
pub fn normalize_label(raw: &str) -> String {
    let label: String = raw.trim().chars().take(MAX_LABEL).collect();
    if label.is_empty() {
        "unnamed device".to_string()
    } else {
        label
    }
}

/// One paired device, as the list shows it.
///
/// No secret in here, and that is why it can be serialised straight onto the
/// wire: the hash lives beside the row in the database and never leaves it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub scopes: ScopeSet,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
    pub revoked_at: Option<i64>,
}

impl Pairing {
    pub fn revoked(&self) -> bool {
        self.revoked_at.is_some()
    }
}

/// A one-time pairing token, before it has been exchanged.
#[derive(Debug, Clone)]
pub struct PendingPairing {
    pub id: String,
    pub secret_hash: String,
    pub label: String,
    pub kind: String,
    pub scopes: ScopeSet,
    pub created_at: i64,
    pub expires_at: i64,
    pub used_at: Option<i64>,
}

/// The two halves a caller presents.
///
/// Same shape for a device credential, a pairing token and a socket ticket, so
/// there is one parser and one place a malformed one is turned away.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credential {
    pub id: String,
    pub secret: String,
}

impl Credential {
    /// `<id>.<secret>`, both hex, neither empty.
    ///
    /// Strict about the shape on purpose: a credential that is *nearly* one is
    /// a typo or a prober, and letting it through to a database lookup makes
    /// the id half a search surface.
    pub fn parse(raw: &str) -> Option<Credential> {
        let raw = raw.trim();
        let (id, secret) = raw.split_once('.')?;
        let hex = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_hexdigit());
        if !hex(id) || !hex(secret) || id.len() > 64 || secret.len() > 128 {
            return None;
        }
        Some(Credential {
            id: id.to_string(),
            secret: secret.to_string(),
        })
    }

    pub fn joined(&self) -> String {
        format!("{}.{}", self.id, self.secret)
    }
}

/// What the database stores instead of the secret.
pub fn hash_secret(secret: &str) -> String {
    let digest = Sha256::digest(secret.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Where a device is sent to exchange a pairing token.
///
/// **The token goes in the fragment, never the path or the query.** A fragment
/// is not sent to the server, so it does not reach an access log, a reverse
/// proxy's log or a `Referer` header on the first outbound request the page
/// makes. The page reads it out of `location.hash` and strips it before
/// anything else can.
pub fn pairing_url(base: &str, token: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    format!("{base}/#pair={token}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_grant_is_stored_exactly_as_it_was_made() {
        let set = ScopeSet::empty().with(Scope::Read).with(Scope::Terminal);
        assert_eq!(set.to_text(), "read,terminal");
        assert_eq!(ScopeSet::parse("read,terminal"), set);
        assert_eq!(ScopeSet::parse(" TERMINAL , read "), set);
    }

    /// The one implication, and the two that deliberately do not exist. A
    /// device paired to rename projects must not come away with a shell.
    #[test]
    fn admin_covers_writing_and_writing_covers_reading_and_nothing_covers_a_terminal() {
        let admin = ScopeSet::empty().with(Scope::Admin);
        assert!(admin.allows(Scope::Read));
        assert!(admin.allows(Scope::Write));
        assert!(admin.allows(Scope::Admin));
        assert!(!admin.allows(Scope::Terminal), "admin handed out a shell");
        assert!(!admin.allows(Scope::Approve));

        let write = ScopeSet::empty().with(Scope::Write);
        assert!(write.allows(Scope::Read));
        assert!(!write.allows(Scope::Admin));

        let read = ScopeSet::empty().with(Scope::Read);
        assert!(read.allows(Scope::Read));
        assert!(!read.allows(Scope::Write));
        assert!(!read.allows(Scope::Terminal));
    }

    /// A scope name from a newer Boite costs the scope, never the connection.
    /// The other way round is a device that cannot be talked to at all after a
    /// downgrade, and no way to revoke it from the app.
    #[test]
    fn a_scope_this_build_does_not_know_is_dropped_rather_than_fatal() {
        let set = ScopeSet::parse("read,teleport,write");
        assert_eq!(set.names(), ["read", "write"]);
        assert!(ScopeSet::parse("").is_empty());
        assert!(ScopeSet::parse("nothing-real").is_empty());
    }

    /// An empty set reaches nothing, which is what a revoked-then-repaired row
    /// with no scopes has to mean.
    #[test]
    fn a_pairing_with_no_scopes_may_do_nothing() {
        let none = ScopeSet::empty();
        for scope in Scope::ALL {
            assert!(!none.allows(scope), "{scope:?}");
            assert!(none.ensure(scope).is_err());
        }
    }

    #[test]
    fn a_credential_is_two_hex_halves_and_nothing_else() {
        let ok = Credential::parse("abc123.deadbeef").unwrap();
        assert_eq!(ok.id, "abc123");
        assert_eq!(ok.secret, "deadbeef");
        assert_eq!(ok.joined(), "abc123.deadbeef");

        for bad in [
            "",
            "abc123",
            ".deadbeef",
            "abc123.",
            "abc 123.deadbeef",
            "abc123.dead beef",
            "zz.deadbeef",
            "abc123.zz",
            "abc123.dead.beef",
        ] {
            assert!(Credential::parse(bad).is_none(), "{bad} was accepted");
        }
    }

    /// The whole point of the pairing link. A token in the path or the query is
    /// a token in an access log on the reverse proxy, which nobody rotates.
    #[test]
    fn the_pairing_link_carries_its_token_in_the_fragment() {
        let url = pairing_url("https://boite.example/", "aa.bb");
        assert_eq!(url, "https://boite.example/#pair=aa.bb");
        let (before, after) = url.split_once('#').unwrap();
        assert!(!before.contains("aa.bb"), "the token reached the server half");
        assert!(after.contains("aa.bb"));
    }

    #[test]
    fn the_stored_hash_is_not_the_secret() {
        let hash = hash_secret("deadbeef");
        assert_eq!(hash.len(), 64);
        assert!(!hash.contains("deadbeef"));
        assert_eq!(hash, hash_secret("deadbeef"));
        assert_ne!(hash, hash_secret("deadbeee"));
    }

    #[test]
    fn a_device_kind_is_one_of_the_words_the_list_can_draw() {
        assert_eq!(normalize_kind("Phone"), "phone");
        assert_eq!(normalize_kind("<img src=x>"), "unknown");
        assert_eq!(normalize_label("  "), "unnamed device");
        assert_eq!(normalize_label(&"x".repeat(200)).chars().count(), MAX_LABEL);
    }

    #[test]
    fn scopes_round_trip_through_json() {
        let set = ScopeSet::standard();
        let json = serde_json::to_string(&set).unwrap();
        assert_eq!(json, r#"["read","write","terminal","approve"]"#);
        let back: ScopeSet = serde_json::from_str(&json).unwrap();
        assert_eq!(back, set);
        let from_text: ScopeSet = serde_json::from_str(r#""read,admin""#).unwrap();
        assert_eq!(from_text, ScopeSet::empty().with(Scope::Read).with(Scope::Admin));
    }
}
