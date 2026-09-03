//! What a method needs, and the only way to reach a handler.
//!
//! Holding a socket used to be authorisation to call everything on it. The fix
//! is not a line at the top of each arm in `rpc.rs` — that is a line a new arm
//! forgets — but a type. [`Authorized`] carries a method and its parameters,
//! its fields are private, and [`Authorized::check`] is its only constructor.
//! `rpc::dispatch` takes one. A transport therefore cannot dispatch work it did
//! not first put through the scope check, in the same way `command::Ready` is
//! the only thing that can be run and `boite_agent_api`'s `Caller` is the only
//! thing a handler can be handed.
//!
//! ## The table is total, and it fails closed
//!
//! [`required`] answers for every method this server serves, in two halves:
//!
//! - the sixty-odd commands on the bus answer from their own declared
//!   [`Capability`], read by name out of `boite_core::command::capabilities`.
//!   There is no second copy to keep in step, so a capability that changes
//!   there changes the device check with it;
//! - everything `rpc.rs` still serves itself — the PTY registry, push
//!   subscriptions, approvals, search, the snapshot, pairing — is in
//!   [`NON_BUS`], which is this file's equivalent of T3 Code's
//!   `RPC_REQUIRED_SCOPES`.
//!
//! A method in neither is **unknown**, not unrestricted. So an arm added to
//! `rpc.rs` without an entry here is dead rather than open, which is the
//! failure direction worth having: the smoke suite says so loudly, and nothing
//! ships accidentally reachable by a read-only phone.

use serde_json::Value;

use boite_core::capability::Capability;
use boite_core::command;
use boite_core::pairing::{Scope, ScopeSet};
use boite_core::store::Store;

use crate::auth::Session;

/// What each method this server serves itself needs.
///
/// `None` is "any device that got through the handshake": the two entries with
/// it carry no workspace state at all, and a device that cannot ask who it is
/// talking to cannot draw a connection banner.
///
/// The three that matter, and why they are not what a name would suggest:
///
/// - `thread.spawn`, `thread.resize`, `thread.kill`, `thread.attach` and the
///   binary input frame are [`Scope::Terminal`], never [`Scope::Write`]. A PTY
///   is arbitrary code on the machine rather than a change to a project, and a
///   read-only device reaching one is the hole this whole file exists to close.
/// - `agent.claimRequest` is [`Scope::Approve`]: claiming means volunteering to
///   carry out what an agent asked for, and a device that takes a claim and
///   cannot act on it has swallowed the request for every other device.
/// - `notify.test` is [`Scope::Admin`]. It makes this server POST somewhere of
///   the operator's choosing, which is not a read.
///
/// `pairing.create` is the one entry this table does not finish on its own.
/// Admin says the device may invite another; it does not say *what* it may
/// invite it with, and an invitation carrying more than its author holds is a
/// way to grant yourself a scope. The arm clamps with
/// [`ScopeSet::clamped_to`] against [`Authorized::caller`], which is why the
/// call's own grant travels with it.
const NON_BUS: &[(&str, Option<Scope>)] = &[
    ("hello", None),
    ("auth", None),
    ("thread.attach", Some(Scope::Terminal)),
    ("thread.detach", Some(Scope::Terminal)),
    ("thread.spawn", Some(Scope::Terminal)),
    ("thread.resize", Some(Scope::Terminal)),
    ("thread.kill", Some(Scope::Terminal)),
    // A keystroke written into a live PTY, so it needs what a keystroke needs.
    // The vocabulary is closed on the way in, but the scope is what says a
    // read-only device cannot answer a dialog on somebody's machine.
    ("thread.reply", Some(Scope::Terminal)),
    ("shell.warm", Some(Scope::Terminal)),
    ("agent.claimRequest", Some(Scope::Approve)),
    ("agent.answerRequest", Some(Scope::Approve)),
    ("agent.mcpConfig", Some(Scope::Read)),
    ("approval.list", Some(Scope::Read)),
    ("approval.decide", Some(Scope::Approve)),
    ("project.homeDir", Some(Scope::Read)),
    ("system.snapshot", Some(Scope::Read)),
    ("system.platform", Some(Scope::Read)),
    ("fs.workspaceRoot", Some(Scope::Read)),
    ("timeline.read", Some(Scope::Read)),
    ("push.publicKey", Some(Scope::Read)),
    ("push.subscribe", Some(Scope::Write)),
    ("push.unsubscribe", Some(Scope::Write)),
    ("notify.test", Some(Scope::Admin)),
    ("pairing.list", Some(Scope::Admin)),
    ("pairing.create", Some(Scope::Admin)),
    ("pairing.revoke", Some(Scope::Admin)),
];

/// The device scope a bus capability asks for.
///
/// The whole mapping, and it is deliberately not a fourth vocabulary: the bus
/// already declares one capability per method and pins the table in a test, so
/// reading it here is what keeps a command that quietly widens from widening
/// the device check silently as well.
pub fn scope_of(capability: Capability) -> Scope {
    match capability {
        Capability::ReadProject => Scope::Read,
        Capability::MutateProject => Scope::Write,
        Capability::MutateAcross => Scope::Admin,
    }
}

/// What this method needs, or the sentence for one nobody serves.
pub fn required(method: &str) -> Result<Option<Scope>, String> {
    if let Some((_, scope)) = NON_BUS.iter().find(|(name, _)| *name == method) {
        return Ok(*scope);
    }
    if let Some(capability) = command::capability_of(method) {
        return Ok(Some(scope_of(capability)));
    }
    Err(format!("unknown method: {method}"))
}

/// A call that has been through the scope check and has nothing left to prove.
///
/// Private fields, one constructor. `rpc::dispatch` takes this and never a bare
/// method name, so an arm cannot be reached without the check having run.
#[derive(Debug)]
pub struct Authorized {
    method: String,
    params: Value,
    /// What the device that sent this holds, carried alongside the call.
    ///
    /// The table above answers "may this method be called at all", which is not
    /// the whole question for the arms that *hand out* authority: `pairing.create`
    /// mints a grant, and a grant may not exceed the one it was made from. So
    /// the caller's own set travels with the call rather than being looked up
    /// again from a session the dispatcher does not have.
    caller: ScopeSet,
    /// Which device sent it, by pairing id.
    ///
    /// The arms that tag what a client wrote need it — a record whose `device`
    /// came out of the body would let one phone file its lines under another —
    /// and it is read here rather than looked up again, because the dispatcher
    /// does not hold the session.
    device: String,
}

impl Authorized {
    /// Checks one call against the device that sent it.
    ///
    /// Three things, in the order they can be answered:
    ///
    /// 1. the pairing is still live. Read from the database on every call, not
    ///    cached from the handshake: revoking a device that only takes effect
    ///    at its next connection is revocation it can outrun by staying
    ///    connected. This is one indexed read of one column;
    /// 2. the method is one this server serves at all;
    /// 3. this device was paired for it.
    pub fn check(
        store: &Store,
        session: &Session,
        method: &str,
        params: Value,
    ) -> Result<Authorized, String> {
        if !store.pairing_is_live(session.pairing_id()) {
            return Err(REVOKED.to_string());
        }
        if let Some(scope) = required(method)? {
            session.scopes().ensure(scope)?;
        }
        Ok(Authorized {
            method: method.to_string(),
            params,
            caller: session.scopes(),
            device: session.pairing_id().to_string(),
        })
    }

    pub fn method(&self) -> &str {
        &self.method
    }

    pub fn params(&self) -> &Value {
        &self.params
    }

    /// What the device that sent this call was paired with.
    pub fn caller(&self) -> ScopeSet {
        self.caller
    }

    /// Which device sent this call.
    pub fn device(&self) -> &str {
        &self.device
    }

    pub fn into_params(self) -> Value {
        self.params
    }
}

/// What a device is told when its pairing is gone.
///
/// A sentence rather than a code, because the client turns it into the login
/// gate and the user is the one who has to act on it.
pub const REVOKED: &str = "this device is no longer paired with this boite";

#[cfg(test)]
mod tests {
    use super::*;

    /// A store holding one live pairing, and a session for it. Nothing is
    /// mocked: the revocation check reads the row this wrote.
    fn paired(tag: &str, id: &str, scopes: ScopeSet) -> (Store, Session, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("boite-authz-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("boite.db")).unwrap();
        store
            .add_pairing(
                &boite_core::pairing::Pairing {
                    id: id.into(),
                    label: "a device".into(),
                    kind: "phone".into(),
                    scopes,
                    created_at: 1,
                    last_seen_at: None,
                    revoked_at: None,
                },
                "hash",
            )
            .unwrap();
        (store, Session::for_test_with_id(id, scopes), dir)
    }

    /// The table has to answer for the whole surface. A method in neither half
    /// is refused, so an arm added to `rpc.rs` with no entry here stops working
    /// rather than opening for everybody.
    #[test]
    fn a_method_nobody_declared_is_refused_rather_than_allowed() {
        assert_eq!(
            required("thread.explode").unwrap_err(),
            "unknown method: thread.explode"
        );
        assert!(required("hello").unwrap().is_none());
        assert_eq!(required("thread.spawn").unwrap(), Some(Scope::Terminal));
        // Off the bus, with no line in NON_BUS at all.
        assert_eq!(required("git.status").unwrap(), Some(Scope::Read));
        assert_eq!(required("git.commit").unwrap(), Some(Scope::Write));
        assert_eq!(required("project.create").unwrap(), Some(Scope::Admin));
    }

    /// No method is declared twice. `NON_BUS` shadows the bus, so an entry that
    /// names a bus method would quietly override the capability the bus pins —
    /// which is the drift this arrangement exists to prevent.
    #[test]
    fn nothing_in_the_local_table_shadows_the_bus() {
        for (method, _) in NON_BUS {
            if *method == "auth" {
                continue;
            }
            assert!(
                command::capability_of(method).is_none(),
                "{method} is declared twice"
            );
        }
        let mut seen = std::collections::BTreeSet::new();
        for (method, _) in NON_BUS {
            assert!(seen.insert(*method), "{method} is listed twice");
        }
    }

    /// The line the whole feature is for. A phone paired to look at the
    /// workspace must not be able to run a command on the machine.
    #[test]
    fn a_read_only_device_cannot_open_a_terminal() {
        let (store, session, dir) =
            paired("readonly", "ro", ScopeSet::empty().with(Scope::Read));
        let refused =
            Authorized::check(&store, &session, "thread.spawn", serde_json::json!({}))
                .unwrap_err();
        assert!(refused.contains("terminal"), "{refused}");

        // What it can do is unchanged.
        assert!(Authorized::check(&store, &session, "git.status", serde_json::json!({})).is_ok());
        assert!(Authorized::check(&store, &session, "hello", serde_json::json!({})).is_ok());
        // And writing is still a scope it does not hold.
        assert!(Authorized::check(&store, &session, "git.commit", serde_json::json!({})).is_err());
        assert!(Authorized::check(&store, &session, "todo.save", serde_json::json!({})).is_err());
        assert!(
            Authorized::check(&store, &session, "pairing.revoke", serde_json::json!({})).is_err(),
            "a read-only device revoked a pairing"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The check reaches a socket that is already open, because it reads the
    /// row rather than what the handshake decided.
    #[test]
    fn a_revoked_pairing_is_refused_on_a_call_it_already_had_a_socket_for() {
        let (store, session, dir) = paired("revoked", "live", ScopeSet::full());

        assert!(Authorized::check(&store, &session, "git.status", serde_json::json!({})).is_ok());
        store.revoke_pairing("live", 2).unwrap();
        assert_eq!(
            Authorized::check(&store, &session, "git.status", serde_json::json!({})).unwrap_err(),
            REVOKED
        );
        // Even the two methods that need no scope at all.
        assert!(Authorized::check(&store, &session, "hello", serde_json::json!({})).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
