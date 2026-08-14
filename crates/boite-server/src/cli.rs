//! What the operator can do from the box the server runs on.
//!
//! Three verbs, and they exist because of one hole: a headless deployment with
//! no device paired to it has no screen to pair the first one from. The
//! bootstrap token opens `POST /api/pairings` for exactly that reason, and this
//! is the same act without a `curl` and a token pasted into a shell history.
//!
//! ```text
//!   boite-server pair [--label L] [--kind K] [--scopes ...] [--minutes N] [--url BASE]
//!   boite-server devices
//!   boite-server revoke <id>
//! ```
//!
//! Every one of them talks to the database rather than to the running server,
//! so they work whether or not it is up. SQLite is in WAL mode, which is what
//! makes a second writer safe here.
//!
//! **A revocation written here reaches a live socket through the row, never
//! through an event.** This is a second process: it cannot broadcast
//! `AppEvent::PairingRevoked`, so nothing in the running server hears it. What
//! catches it is that every path carrying authority re-reads the row:
//! `authz::Authorized::check` per RPC, and `ws::Liveness` on the two paths that
//! carry PTY bytes. That second half was missing, and without it a device
//! attached to a terminal and sending only keystrokes kept full shell access
//! across a revocation this command had already written.
//!
//! Hand-rolled argument parsing, and it stays that way: three verbs and six
//! flags do not justify a dependency in a server binary, and the failure mode
//! of a flag nobody understands is a printed usage line rather than a wrong
//! grant.

use boite_core::now_ms;
use boite_core::pairing::{self, ScopeSet};
use boite_core::store::Store;

use crate::auth;
use crate::config::Config;
use crate::pairing_link;

pub const USAGE: &str = "\
boite-server                                    run the server
boite-server pair [options]                     invite one device
boite-server devices                            list what is paired
boite-server revoke <id>                        shut one device out

pair options:
  --label <text>      what the devices list calls it
  --kind <word>       desktop | phone | tablet | browser | cli
  --scopes <list>     read,write,terminal,approve,admin  (default: all but admin)
  --minutes <n>       how long the invitation stands     (default: 10)
  --url <base>        what the link points at, when BOITE_PUBLIC_URL is not set
";

/// Whether the arguments name a verb rather than a run.
pub fn is_command(args: &[String]) -> bool {
    matches!(args.first().map(String::as_str), Some("pair" | "devices" | "revoke" | "help" | "--help" | "-h"))
}

/// Runs one verb. The exit code is what `main` gives the shell.
pub fn run(args: &[String]) -> i32 {
    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[boite-server] config error: {e}");
            return 1;
        }
    };
    let store = match Store::open(&config.data_dir.join("boite.db")) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[boite-server] store error: {e}");
            return 1;
        }
    };
    match args[0].as_str() {
        "pair" => pair(&store, &config, &args[1..]),
        "devices" => devices(&store),
        "revoke" => revoke(&store, args.get(1).map(String::as_str)),
        _ => {
            println!("{USAGE}");
            0
        }
    }
}

/// The value after a flag, when it is there and is not the next flag.
fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let at = args.iter().position(|a| a == name)?;
    args.get(at + 1)
        .map(String::as_str)
        .filter(|v| !v.starts_with("--"))
}

fn pair(store: &Store, config: &Config, args: &[String]) -> i32 {
    let label = flag(args, "--label").unwrap_or("a new device");
    let kind = flag(args, "--kind").unwrap_or("unknown");
    let scopes = match flag(args, "--scopes") {
        Some(list) => {
            let parsed = ScopeSet::parse(list);
            if parsed.is_empty() {
                eprintln!("no scope in {list:?} is one this build knows. {USAGE}");
                return 1;
            }
            parsed
        }
        None => ScopeSet::standard(),
    };
    let minutes = flag(args, "--minutes")
        .and_then(|m| m.parse::<i64>().ok())
        .unwrap_or(10)
        .clamp(1, 24 * 60);
    let base = config
        .public_url
        .clone()
        .or_else(|| flag(args, "--url").map(|u| u.trim_end_matches('/').to_string()));
    let Some(base) = base else {
        eprintln!(
            "this server does not know what name it is reached by. \
             Set BOITE_PUBLIC_URL, or pass --url https://boite.example"
        );
        return 1;
    };

    let now = now_ms();
    let token = match auth::mint_pairing_token(store, label, kind, scopes, now, minutes * 60_000) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[boite-server] could not write the invitation: {e}");
            return 1;
        }
    };
    let url = pairing::pairing_url(&base, &token);
    print!("{}", pairing_link::printed(&url, label, scopes, minutes));
    0
}

fn devices(store: &Store) -> i32 {
    let rows = match store.list_pairings() {
        Ok(rows) => rows,
        Err(e) => {
            eprintln!("[boite-server] {e}");
            return 1;
        }
    };
    if rows.is_empty() {
        println!("nothing is paired with this boite. `boite-server pair` invites the first one.");
        return 0;
    }
    for row in rows {
        println!(
            "{}  {:<24} {:<8} {:<32} last seen {}{}",
            row.id,
            row.label,
            row.kind,
            row.scopes.to_text(),
            row.last_seen_at.map(stamp).unwrap_or_else(|| "never".into()),
            if row.revoked() { "  REVOKED" } else { "" },
        );
    }
    0
}

fn revoke(store: &Store, id: Option<&str>) -> i32 {
    let Some(id) = id else {
        eprintln!("which one? `boite-server devices` lists them.");
        return 1;
    };
    match store.revoke_pairing(id, now_ms()) {
        Ok(true) => {
            println!("{id} is out. Its next call is refused, and the socket it may be holding goes with it.");
            0
        }
        Ok(false) => {
            eprintln!("{id} is not a device this boite has, or was already revoked.");
            1
        }
        Err(e) => {
            eprintln!("[boite-server] {e}");
            1
        }
    }
}

/// How long ago, in words. A wall-clock date would need a formatting crate for
/// a column nobody sorts on.
fn stamp(at: i64) -> String {
    let ago = (now_ms() - at).max(0) / 1000;
    match ago {
        0..=90 => format!("{ago}s ago"),
        91..=5400 => format!("{}m ago", ago / 60),
        5401..=172_800 => format!("{}h ago", ago / 3600),
        _ => format!("{}d ago", ago / 86_400),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_verb_is_told_apart_from_a_run() {
        assert!(is_command(&["pair".to_string()]));
        assert!(is_command(&["devices".to_string()]));
        assert!(is_command(&["--help".to_string()]));
        assert!(!is_command(&[]));
        assert!(!is_command(&["--bind".to_string()]));
    }

    /// A flag whose value is the next flag has no value. Without this,
    /// `--label --scopes read` would name a device `--scopes`.
    #[test]
    fn a_flag_with_no_value_has_none() {
        let args: Vec<String> = ["--label", "--scopes", "read"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(flag(&args, "--label"), None);
        assert_eq!(flag(&args, "--scopes"), Some("read"));
        assert_eq!(flag(&args, "--minutes"), None);
    }

    #[test]
    fn how_long_ago_reads_as_a_person_would_say_it() {
        let now = now_ms();
        assert!(stamp(now).ends_with("s ago"));
        assert!(stamp(now - 600_000).ends_with("m ago"));
        assert!(stamp(now - 36_000_000).ends_with("h ago"));
        assert!(stamp(now - 864_000_000).ends_with("d ago"));
    }
}
