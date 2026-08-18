use super::Options;
use crate::jsonio;
use crate::live;
use crate::pool::{self, Pool};
use crate::provider::{self, Provider};
use crate::term::{say, Color};

pub fn run(provider: &Provider, opts: &Options) -> i32 {
    let Some(raw) = live::creds_raw(provider) else {
        say(
            &format!(
                "No {} credentials found ({}).",
                provider.label, provider.cred_label
            ),
            Color::Red,
        );
        say(
            &format!(
                "Run /login in {} first, then add the account.",
                provider.label
            ),
            Color::Dim,
        );
        return 1;
    };

    let identity = live::identity(provider);
    let email = opts.email.clone().or_else(|| {
        identity
            .as_ref()
            .and_then(|id| jsonio::str_of(id, "emailAddress"))
    });
    let Some(email) = email.filter(|e| !e.is_empty()) else {
        say("Could not work out which account this is.", Color::Red);
        say(
            "Pass one: kebacc-switch add -Provider codex -Email you@example.com",
            Color::Dim,
        );
        return 2;
    };

    if std::fs::create_dir_all(&provider.store).is_err() {
        say("The pool directory could not be created.", Color::Red);
        return 1;
    }
    provider::protect_dir(&provider.store);

    let path = provider.snapshot_path(&email);
    let existed = path.exists();
    let previous = jsonio::read(&path);
    let cache = previous.as_ref().and_then(|p| jsonio::obj(p, "usageCache"));
    let saved = previous.as_ref().and_then(|p| jsonio::str_of(p, "savedAt"));

    let (snapshot, protected) = pool::new_snapshot(
        &email,
        &raw,
        identity.as_ref(),
        cache.as_ref(),
        saved.as_deref(),
    );
    if jsonio::write(&path, &snapshot).is_err() {
        say("The account could not be written to the pool.", Color::Red);
        return 1;
    }

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let registered = Pool::new(provider).register(&file_name, &snapshot);

    if !opts.quiet {
        say(
            &format!(
                "{} {} ({})",
                if existed { "Updated" } else { "Saved" },
                email,
                provider.label
            ),
            Color::Green,
        );
        if !protected {
            say(
                "Stored in plain text: no OS secret store was available on this machine.",
                Color::Yellow,
            );
        }
        if !registered {
            say(
                "Saved but not stamped: this account has no stable id to stamp.",
                Color::Dim,
            );
        }
    }
    0
}
