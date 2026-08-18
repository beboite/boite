use super::Options;
use crate::pool::Pool;
use crate::provider::Provider;
use crate::term::{ask, said_yes, say, Color};

pub fn run(provider: &Provider, opts: &Options) -> i32 {
    let store = Pool::new(provider);
    let pool = store.entries();
    if pool.is_empty() {
        say(
            &format!("No accounts saved for {}.", provider.label),
            Color::Yellow,
        );
        return 0;
    }

    let target = match opts.email.as_deref().filter(|e| !e.is_empty()) {
        Some(email) => {
            let key = email.to_lowercase();
            pool.iter().find(|e| e.email.to_lowercase() == key)
        }
        None => {
            for (index, entry) in pool.iter().enumerate() {
                say(&format!("  [{}] {}", index + 1, entry.email), Color::Plain);
            }
            let answer = ask("Remove which number");
            match super::chosen_index(&answer, pool.len()) {
                Some(index) => Some(&pool[index]),
                None => {
                    say("Nothing removed.", Color::Dim);
                    return 0;
                }
            }
        }
    };

    let Some(target) = target else {
        say("No matching account.", Color::Red);
        return 1;
    };

    if !opts.yes
        && !said_yes(&ask(&format!(
            "Remove {} from the pool? [y/N]",
            target.email
        )))
    {
        say("Nothing removed.", Color::Dim);
        return 0;
    }

    if std::fs::remove_file(&target.file).is_err() {
        say("The snapshot could not be removed.", Color::Red);
        return 1;
    }
    store.unregister(&target.file_name());
    say(
        &format!("Removed {}. The live login is untouched.", target.email),
        Color::Green,
    );
    0
}
