use super::Options;
use crate::pool::{Pool, Trust};
use crate::provider::Provider;
use crate::term::{say, Color};
use crate::usage;

pub fn run(provider: &Provider, opts: &Options) -> i32 {
    let pool = Pool::new(provider).entries();
    say(
        &format!("{} — {}", provider.label, provider.store.display()),
        Color::Cyan,
    );
    if pool.is_empty() {
        say("No accounts saved yet.", Color::Yellow);
        say(
            &format!(
                "Log in to {}, then run: kebacc-switch add -Provider {}",
                provider.label,
                provider.id.as_str()
            ),
            Color::Dim,
        );
        return 0;
    }

    let current = super::current(provider, &pool);
    let mut problem = false;

    for entry in &pool {
        let live = current.is_some_and(|c| c.file == entry.file);
        let mark = if live { '*' } else { ' ' };
        let usage = if opts.refresh {
            usage::for_entry(provider, entry, true)
        } else {
            usage::from_cache(entry.cache.as_ref())
        };
        let pair = match &usage {
            Some(usage) => usage.as_pair(),
            None => "usage n/a".to_string(),
        };
        let mut line = format!("{mark} {:<34} {pair}", entry.email);

        if let Some(ready) = usage.as_ref().and_then(|u| u.ready_at()) {
            line.push_str(&format!("  back in {}", usage::wait_text(ready)));
        }

        let mut colour = if live { Color::Green } else { Color::Plain };
        if usage.as_ref().is_some_and(|u| !u.usable()) {
            colour = Color::Dim;
        }
        say(&line, colour);

        if entry.trust != Trust::Trusted {
            let (text, colour) = entry.trust.verdict();
            say(&format!("  ! {text}"), colour);
            problem = true;
        }
        if !entry.protected {
            say("  ! stored in plain text", Color::Yellow);
            problem = true;
        }
        if entry.creds.is_none() {
            say("  ! credentials could not be read back", Color::Red);
            problem = true;
        }
    }

    if current.is_none() {
        say("The live login is not one of the saved ones.", Color::Dim);
    }
    if problem {
        1
    } else {
        0
    }
}
