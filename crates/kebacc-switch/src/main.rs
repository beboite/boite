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
    cmd::update::sweep();
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(dispatch(&args));
}

fn usage_text() {
    println!("kebacc-switch <command> [-Provider claude|codex|all] [options]");
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
    println!("  update      install the newest release (-Check to only say whether one is out)");
    println!();
    println!("  list -Countdown   both quota windows of every saved account, with their resets");
    println!("  auto -Midtask     auto from a tool-use hook, at most once every few minutes");
    println!();
    println!("  Updates install themselves once a day at session start. KEBACC_SWITCH_UPDATE=off stops that.");
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
        println!("kebacc-switch {}", env!("CARGO_PKG_VERSION"));
        return 0;
    }
    let command = match command.as_str() {
        "ls" => "list",
        "select" | "use" => "switch",
        "rm" => "remove",
        "save" => "add",
        "check" => "doctor",
        "upgrade" | "selfupdate" => "update",
        other => other,
    };
    if !matches!(
        command,
        "add" | "list" | "switch" | "remove" | "auto" | "doctor" | "statusline" | "update"
    ) {
        say(&format!("Unknown command '{command}'."), Color::Red);
        usage_text();
        return 64;
    }

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

    if command == "update" {
        return cmd::update::run(&options);
    }

    if command == "auto" && options.hook && !options.spawned {
        cmd::update::maybe();
    }

    if command == "auto" && options.midtask {
        return cmd::midtask::run(&wanted);
    }

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
        "list" if options.countdown => cmd::countdown::run(&provider),
        "list" => cmd::list::run(&provider, options),
        "switch" => cmd::switch::run(&provider, options),
        "remove" => cmd::remove::run(&provider, options),
        "auto" => cmd::auto::run(&provider, options),
        _ => cmd::doctor::run(&provider, options),
    }
}

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
            "email" | "e" => options.email = Some(value().ok_or("-Email needs an address.")?),
            "quiet" => options.quiet = true,
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
            "countdown" => options.countdown = true,
            "midtask" => options.midtask = true,
            "check" => options.check = true,
            "spawned" => options.spawned = true,
            other => return Err(format!("Unknown option '-{other}'.")),
        }
    }
    Ok((provider, options))
}
