use super::Options;
use crate::live;
use crate::pool::{Entry, Pool, Trust};
use crate::provider::Provider;
use crate::term::{ask, said_yes, say, Color};

pub fn run(provider: &Provider, opts: &Options) -> i32 {
    let pool = Pool::new(provider).entries();
    if pool.is_empty() {
        say(
            &format!("No accounts saved for {}.", provider.label),
            Color::Yellow,
        );
        return 0;
    }

    let current = super::current(provider, &pool);
    let Some(target) = pick(&pool, current, opts.email.as_deref()) else {
        say("No matching account.", Color::Red);
        return 1;
    };
    if current.is_some_and(|c| c.file == target.file) {
        say(&format!("Already on {}.", target.email), Color::Dim);
        return 0;
    }

    if target.trust != Trust::Trusted {
        let (text, colour) = target.trust.verdict();
        say(
            &format!(
                "This account is {text}: it is not one this machine registered, or it has changed since."
            ),
            colour,
        );
        if !opts.yes && !said_yes(&ask("Switch to it anyway? [y/N]")) {
            return 1;
        }
    }

    if let Err(problem) = live::activate(provider, target) {
        say(&problem, Color::Red);
        return 1;
    }
    say(
        &format!("Switched {} to {}", provider.label, target.email),
        Color::Green,
    );
    say(
        "Restart or /login-free reload the CLI for it to pick the change up.",
        Color::Dim,
    );
    10
}

fn pick<'a>(pool: &'a [Entry], current: Option<&Entry>, wanted: Option<&str>) -> Option<&'a Entry> {
    if let Some(wanted) = wanted.filter(|w| !w.is_empty()) {
        let key = wanted.to_lowercase();
        if let Some(hit) = pool.iter().find(|e| e.email.to_lowercase() == key) {
            return Some(hit);
        }
        let near: Vec<&Entry> = pool
            .iter()
            .filter(|e| e.email.to_lowercase().starts_with(&key))
            .collect();
        if near.len() == 1 {
            return Some(near[0]);
        }
        if near.len() > 1 {
            say(
                &format!("'{wanted}' matches {} accounts:", near.len()),
                Color::Yellow,
            );
            for one in near {
                say(&format!("  {}", one.email), Color::Plain);
            }
        }
        return None;
    }

    if pool.len() == 2 {
        if let Some(current) = current {
            return pool.iter().find(|e| e.file != current.file);
        }
    }
    for (index, entry) in pool.iter().enumerate() {
        let mark = if current.is_some_and(|c| c.file == entry.file) {
            '*'
        } else {
            ' '
        };
        say(
            &format!("{mark} [{}] {}", index + 1, entry.email),
            Color::Plain,
        );
    }
    let answer = ask("Switch to which number");
    super::chosen_index(&answer, pool.len()).map(|index| &pool[index])
}
