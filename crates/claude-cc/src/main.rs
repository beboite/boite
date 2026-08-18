//! The one entry point. Everything else is reached through it.
//!
//!   claude-cc <command> [-Provider claude|codex|all] [options]
//!
//! The option names are the ones the PowerShell version took, because the slash
//! commands, the hooks and the muscle memory of anyone upgrading all spell them
//! that way. They are matched without regard to case, and `--provider` works as
//! well as `-Provider`.

mod cmd;
mod jsonio;
mod live;
mod lock;
mod pool;
mod provider;
mod seal;
mod term;
mod usage;

use cmd::Options;
use provider::ProviderId;
use term::{say, Color};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(dispatch(&args));
}

fn usage_text() {
    println!("claude-cc <command> [-Provider claude|codex|all] [options]");
    println!();
    println!("  add         save the login the CLI is using right now");
    println!(
        "  list        the saved logins and what is known of their quota (-Refresh to ask the API)"
    );
    println!("  switch      change which saved login the CLI uses");
    println!("  remove      forget a saved login");
    println!("  auto        switch only if the one in use is out of quota");
    println!("  doctor      check the install and the pool (-Protect, -Adopt, -Clean to repair, -Rollback to undo a switch)");
    println!("  statusline  the Claude Code status line, from a payload on stdin");
}

fn dispatch(args: &[String]) -> i32 {
    let command = args
        .first()
        .map(|c| c.to_lowercase())
        .unwrap_or_else(|| "list".into());
    if matches!(command.as_str(), "-h" | "--help" | "help" | "") {
        usage_text();
        return 0;
    }
    if matches!(command.as_str(), "-v" | "--version" | "version") {
        println!("claude-cc {}", env!("CARGO_PKG_VERSION"));
        return 0;
    }
    let command = match command.as_str() {
        "ls" => "list",
        "select" | "use" => "switch",
        "rm" => "remove",
        "save" => "add",
        "check" => "doctor",
        other => other,
    };
    if !matches!(
        command,
        "add" | "list" | "switch" | "remove" | "auto" | "doctor" | "statusline"
    ) {
        say(&format!("Unknown command '{command}'."), Color::Red);
        usage_text();
        return 64;
    }

    // The status line is handed a payload rather than options, and reads the
    // pools of both providers itself.
    if command == "statusline" {
        return cmd::statusline::run();
    }

    let (wanted, options) = match parse(&args[1..]) {
        Ok(parsed) => parsed,
        Err(problem) => {
            say(&problem, Color::Red);
            return 64;
        }
    };

    // `all` is not a provider — it runs the command once per provider. It is
    // caught here, before anything tries to resolve it into a provider spec.
    if provider::is_all(&wanted) {
        let mut worst = 0;
        for (index, id) in [ProviderId::Claude, ProviderId::Codex]
            .into_iter()
            .enumerate()
        {
            if index > 0 {
                println!();
            }
            let code = run(command, id, &options);
            // The loudest child owns the exit code: a setup problem in one
            // provider must not be hidden by a clean run in the other.
            if code > worst {
                worst = code;
            }
        }
        return hushed(worst, &options);
    }

    match provider::resolve(&wanted) {
        Ok(id) => hushed(run(command, id, &options), &options),
        Err(problem) => {
            say(&problem, Color::Red);
            64
        }
    }
}

/// A hook's exit code, which is zero whatever happened underneath.
fn hushed(code: i32, options: &Options) -> i32 {
    if options.hook {
        0
    } else {
        code
    }
}

fn run(command: &str, id: ProviderId, options: &Options) -> i32 {
    let provider = provider::spec(id);
    match command {
        "add" => cmd::add::run(&provider, options),
        "list" => cmd::list::run(&provider, options),
        "switch" => cmd::switch::run(&provider, options),
        "remove" => cmd::remove::run(&provider, options),
        "auto" => cmd::auto::run(&provider, options),
        _ => cmd::doctor::run(&provider, options),
    }
}

/// The options, as named flags. A bare word is nobody's option, and taking it
/// for one would switch to the wrong account: the email goes after `-Email`.
fn parse(tokens: &[String]) -> Result<(String, Options), String> {
    let mut provider = "claude".to_string();
    let mut options = Options::default();
    let mut index = 0;

    while index < tokens.len() {
        let token = &tokens[index];
        index += 1;
        let Some(name) = token.strip_prefix('-') else {
            return Err(format!(
                "Unexpected argument '{token}'. Options are named: -Email you@example.com"
            ));
        };
        let name = name.trim_start_matches('-').to_lowercase();
        let mut value = || {
            let next = tokens.get(index).filter(|t| !t.starts_with('-'));
            if next.is_some() {
                index += 1;
            }
            next.cloned()
        };
        match name.as_str() {
            "provider" | "p" => {
                provider = value().ok_or("-Provider needs a name: claude, codex or all.")?
            }
            "email" | "e" => options.email = value(),
            "quiet" => options.quiet = true,
            // What a SessionStart hook prints is fed to the model and what it
            // returns is shown to the user at every start, so a hook says
            // nothing and always succeeds — including for the exit codes that
            // mean "there was nothing to do".
            "hook" => {
                options.quiet = true;
                options.hook = true;
            }
            "refresh" => options.refresh = true,
            "yes" | "y" => options.yes = true,
            "protect" => options.protect = true,
            "adopt" => options.adopt = true,
            "rollback" => options.rollback = true,
            "clean" => options.clean = true,
            other => return Err(format!("Unknown option '-{other}'.")),
        }
    }
    Ok((provider, options))
}
