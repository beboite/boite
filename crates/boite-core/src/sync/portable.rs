//! Making one configuration file mean the same thing on two machines.
//!
//! Two transformations happen on the way out and reverse on the way in: a home
//! directory becomes a token, and a field a rule named becomes a placeholder.
//! Both are substitutions on the file's own bytes, and that is the constraint
//! the whole module is built around.
//!
//! `serde_json` here has no `preserve_order`, so parsing a document and writing
//! it back alphabetises every object. `~/.copilot/config.json` is JSONC, with
//! comments and a trailing comma, so writing it back at all destroys it. And
//! `commands/agents.rs` already states the refusal to parse and merge somebody
//! else's config for the same reason. So JSON is parsed here to *find* things
//! and never to write them: what reaches the repository is the original text
//! with two kinds of substring swapped out, and a file that declares no rule is
//! never parsed at all.
//!
//! A value is located in the file in its *escaped* form. The parsed value of
//! `"-File \"C:\\Users\\me\\x.ps1\""` is not the text the file holds, and a
//! substitution that searched for the parsed form would silently find nothing.

use serde_json::Value;

use super::manifest::{Field, Rule};

/// What a home directory becomes on the way to the repository.
pub const HOME_TOKEN: &str = "${BOITE_HOME}";

const SECRET_PREFIX: &str = "__BOITE_SECRET:";
const LOCAL_PREFIX: &str = "__BOITE_LOCAL:";
const PLACEHOLDER_END: &str = "__";

/// Below this many characters, a value is not substituted.
///
/// The mechanism replaces every occurrence of a value's own text. A four
/// character value in a configuration file is not a credential, and replacing
/// it blindly would corrupt unrelated text that happens to read the same.
const MIN_SUBSTITUTABLE: usize = 8;

/// A rule that reached a value and did something to it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    /// The concrete pointer, wildcards resolved: `/mcpServers/github/headers/Authorization`.
    pub pointer: String,
    pub field: Field,
}

/// A rule that reached nothing, or something it will not touch.
///
/// Named rather than silent: "there was nothing to redact" and "there was
/// something and it was left alone" are different things for a user deciding
/// whether to trust what just went to a git remote.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub pointer: String,
    pub reason: Reason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    /// The file is not JSON this can parse — JSONC, or malformed. The file still
    /// syncs; nothing was found, so nothing was substituted.
    NotJson,
    /// The pointer reached a number, an object or an array. The mechanism swaps
    /// a value's own text for a placeholder, and there is no text to swap.
    NotAString,
    /// Shorter than `MIN_SUBSTITUTABLE`.
    TooShort,
    /// The pointer reached nothing in this file.
    NotFound,
    /// The value parsed but its text could not be located byte for byte, which
    /// happens when the file spells an escape differently from `serde_json`.
    NotInText,
    /// A key in the pointer contains the placeholder terminator, so a
    /// placeholder keyed on it could not be read back. Refused rather than
    /// written and mis-parsed on the other machine.
    PointerNotRepresentable,
}

pub struct Redaction {
    pub text: String,
    pub applied: Vec<Applied>,
    pub skipped: Vec<Skipped>,
}

pub struct Restoration {
    pub text: String,
    /// Placeholders this machine had no local value for. The placeholder is left
    /// in place: the file stays valid JSON, and the value that is there names
    /// Boite and the field it came from rather than being empty.
    pub needed: Vec<Applied>,
}

/// The whole outbound pipeline, in the order that matters.
///
/// Redaction first, so a secret that happens to contain a home path travels as
/// one placeholder rather than as a tokenised fragment of one.
pub fn outbound(text: &str, rules: &[Rule], home: &str) -> Redaction {
    let mut redacted = redact(text, rules);
    redacted.text = to_token(&redacted.text, home);
    redacted
}

/// The whole inbound pipeline, the reverse order.
///
/// The token is expanded first, so what `restore` compares and writes is a path
/// this machine could actually open.
pub fn inbound(text: &str, local: Option<&str>, home: &str) -> Restoration {
    restore(&from_token(text, home), local)
}

// ---------------------------------------------------------------- home tokens

/// Replaces this machine's home directory with `HOME_TOKEN`, in every spelling
/// a configuration file uses.
///
/// Three of them: native (`C:\Users\me`), JSON-escaped (`C:\\Users\\me`, which
/// is what the bytes of a JSON file actually hold) and forward-slashed
/// (`C:/Users/me`, which plenty of tools write on Windows). Only the prefix is
/// replaced; the rest of the path is left exactly as it was.
pub fn to_token(text: &str, home: &str) -> String {
    to_token_with(text, home, cfg!(windows))
}

/// The same, with the case rule as an argument so both branches are testable on
/// either platform. A Windows configuration that spells `c:\users\me` is real.
pub fn to_token_with(text: &str, home: &str, ignore_case: bool) -> String {
    if home.is_empty() {
        return text.to_string();
    }
    let escaped = home.replace('\\', "\\\\");
    let forward = home.replace('\\', "/");
    let mut out = text.to_string();
    // Longest first: the escaped spelling contains the native one's characters
    // doubled, and replacing the short form first would leave stray separators.
    for needle in [escaped.as_str(), forward.as_str(), home] {
        if needle.is_empty() {
            continue;
        }
        out = if ignore_case {
            replace_ignoring_ascii_case(&out, needle, HOME_TOKEN)
        } else {
            out.replace(needle, HOME_TOKEN)
        };
    }
    out
}

/// Expands `HOME_TOKEN` back, in the spelling the character after it asks for.
///
/// One deterministic rule rather than a guess: two backslashes mean the file is
/// JSON-escaped, one means it is native, a slash means it is forward-slashed,
/// and a token at the very end of a string gets the native spelling. The repo
/// copy stays readable in a diff, which matters because a human reads it in the
/// merge tool.
pub fn from_token(text: &str, home: &str) -> String {
    if !text.contains(HOME_TOKEN) {
        return text.to_string();
    }
    let escaped = home.replace('\\', "\\\\");
    let forward = home.replace('\\', "/");
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(HOME_TOKEN) {
        out.push_str(&rest[..at]);
        let after = &rest[at + HOME_TOKEN.len()..];
        let spelling = if after.starts_with("\\\\") {
            escaped.as_str()
        } else if after.starts_with('\\') {
            home
        } else if after.starts_with('/') {
            forward.as_str()
        } else {
            home
        };
        out.push_str(spelling);
        rest = after;
    }
    out.push_str(rest);
    out
}

/// `str::replace`, matching ASCII letters in either case.
///
/// Byte indices stay valid because `to_ascii_lowercase` only maps `A-Z` and
/// leaves every other byte, multi-byte UTF-8 included, exactly where it was.
fn replace_ignoring_ascii_case(haystack: &str, needle: &str, with: &str) -> String {
    if needle.is_empty() {
        return haystack.to_string();
    }
    let hay = haystack.to_ascii_lowercase();
    let pin = needle.to_ascii_lowercase();
    let mut out = String::with_capacity(haystack.len());
    let mut cursor = 0usize;
    while let Some(offset) = hay[cursor..].find(&pin) {
        let at = cursor + offset;
        out.push_str(&haystack[cursor..at]);
        out.push_str(with);
        cursor = at + needle.len();
    }
    out.push_str(&haystack[cursor..]);
    out
}

// ------------------------------------------------------------------ redaction

/// Swaps every value a rule names for a placeholder that names the field it came
/// from.
///
/// Two properties this has to keep, both of them tested. It is idempotent: on
/// the next push the local value *is* the placeholder, so the substitution is a
/// no-op. And it produces the same bytes on every machine, so two computers with
/// different credentials in the same file compare equal and a secret can never
/// be the reason the merge tool opens.
pub fn redact(text: &str, rules: &[Rule]) -> Redaction {
    if rules.is_empty() {
        return Redaction { text: text.to_string(), applied: Vec::new(), skipped: Vec::new() };
    }
    let Ok(root) = serde_json::from_str::<Value>(text) else {
        return Redaction {
            text: text.to_string(),
            applied: Vec::new(),
            skipped: rules
                .iter()
                .map(|rule| Skipped { pointer: rule.pointer.to_string(), reason: Reason::NotJson })
                .collect(),
        };
    };
    let mut out = text.to_string();
    let mut applied = Vec::new();
    let mut skipped = Vec::new();
    for rule in rules {
        let hits = resolve_pointer(&root, rule.pointer);
        if hits.is_empty() {
            skipped.push(Skipped { pointer: rule.pointer.to_string(), reason: Reason::NotFound });
            continue;
        }
        for (pointer, found) in hits {
            let Some(reason) = redact_one(&mut out, &pointer, rule.field, found) else {
                applied.push(Applied { pointer, field: rule.field });
                continue;
            };
            skipped.push(Skipped { pointer, reason });
        }
    }
    Redaction { text: out, applied, skipped }
}

/// `None` when the value was substituted or was already the placeholder.
fn redact_one(text: &mut String, pointer: &str, field: Field, found: &Value) -> Option<Reason> {
    if found.as_str().is_none() {
        return Some(Reason::NotAString);
    }
    // Both of these are refusals, not successes. `?` here would hand back `None`,
    // which this function spells "substituted", and a value nobody could key a
    // placeholder on would have been reported as redacted while still sitting in
    // the file.
    let Some(needle) = escaped_text(found) else {
        return Some(Reason::NotInText);
    };
    if needle.chars().count() < MIN_SUBSTITUTABLE {
        return Some(Reason::TooShort);
    }
    let Some(marker) = placeholder(field, pointer) else {
        return Some(Reason::PointerNotRepresentable);
    };
    if needle == marker {
        // Already redacted on a previous push. Reported as applied, because from
        // the caller's point of view the field is handled either way.
        return None;
    }
    if !text.contains(&needle) {
        return Some(Reason::NotInText);
    }
    *text = text.replace(&needle, &marker);
    None
}

/// Puts back what this machine already had, wherever a placeholder stands.
///
/// A pull never blanks a local credential: it restores it. When there is nothing
/// local to restore — a fresh machine, or a field never set — the placeholder is
/// left exactly where it is and reported, rather than the key being dropped,
/// which would mean re-serialising the document.
pub fn restore(text: &str, local: Option<&str>) -> Restoration {
    let markers = placeholders_in(text);
    if markers.is_empty() {
        return Restoration { text: text.to_string(), needed: Vec::new() };
    }
    let local_root = local.and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let mut out = text.to_string();
    let mut needed = Vec::new();
    for (marker, pointer, field) in markers {
        let local_value = local_root
            .as_ref()
            .and_then(|root| resolve_pointer(root, &pointer).into_iter().next())
            .and_then(|(_, value)| escaped_text(value));
        match local_value {
            // A local value that is itself the placeholder is not a value: this
            // machine has never had one either.
            Some(value) if value != marker => out = out.replace(&marker, &value),
            _ => needed.push(Applied { pointer, field }),
        }
    }
    Restoration { text: out, needed }
}

/// The placeholder a field is swapped for, keyed on where it came from.
///
/// `None` when the pointer contains the terminator, because a placeholder keyed
/// on it could not be read back unambiguously.
fn placeholder(field: Field, pointer: &str) -> Option<String> {
    if pointer.contains(PLACEHOLDER_END) {
        return None;
    }
    let prefix = match field {
        Field::Secret => SECRET_PREFIX,
        Field::MachineLocal => LOCAL_PREFIX,
    };
    Some(format!("{prefix}{pointer}{PLACEHOLDER_END}"))
}

/// Every placeholder in a document, as `(whole marker, pointer, field)`.
fn placeholders_in(text: &str) -> Vec<(String, String, Field)> {
    let mut found = Vec::new();
    for (prefix, field) in [(SECRET_PREFIX, Field::Secret), (LOCAL_PREFIX, Field::MachineLocal)] {
        let mut cursor = 0usize;
        while let Some(offset) = text[cursor..].find(prefix) {
            let start = cursor + offset;
            let body_at = start + prefix.len();
            let Some(end_offset) = text[body_at..].find(PLACEHOLDER_END) else {
                break;
            };
            let body_end = body_at + end_offset;
            let pointer = text[body_at..body_end].to_string();
            let marker = text[start..body_end + PLACEHOLDER_END.len()].to_string();
            if !found.iter().any(|(existing, _, _)| existing == &marker) {
                found.push((marker, pointer, field));
            }
            cursor = body_end + PLACEHOLDER_END.len();
        }
    }
    found
}

/// A string value as the file spells it, without the surrounding quotes.
///
/// This is what is searched for and what is written back, because the bytes in
/// the file are escaped and the parsed value is not.
fn escaped_text(value: &Value) -> Option<String> {
    let quoted = serde_json::to_string(value).ok()?;
    let inner = quoted.strip_prefix('"')?.strip_suffix('"')?;
    Some(inner.to_string())
}

// -------------------------------------------------------------- json pointers

/// Every concrete pointer a pattern reaches, with the value found there.
///
/// `*` matches exactly one map key, so `/mcpServers/*/headers/Authorization`
/// covers every server in a file without naming one. The pointers handed back
/// are concrete and RFC 6901 escaped, because a placeholder is keyed on them and
/// the other machine looks the same key up.
///
/// A map key spelled `*` is read as the wildcard. No configuration in scope has
/// one, and the alternative is an escape nobody would ever write.
fn resolve_pointer<'v>(root: &'v Value, pattern: &str) -> Vec<(String, &'v Value)> {
    let mut segments: Vec<&str> = pattern.split('/').collect();
    if segments.first() == Some(&"") {
        segments.remove(0);
    }
    let mut out = Vec::new();
    walk(root, &segments, String::new(), &mut out);
    out
}

fn walk<'v>(node: &'v Value, segments: &[&str], prefix: String, out: &mut Vec<(String, &'v Value)>) {
    let Some((segment, rest)) = segments.split_first() else {
        out.push((prefix, node));
        return;
    };
    if *segment == "*" {
        if let Value::Object(map) = node {
            for (key, value) in map {
                walk(value, rest, format!("{prefix}/{}", escape_segment(key)), out);
            }
        }
        return;
    }
    let key = unescape_segment(segment);
    match node {
        Value::Object(map) => {
            if let Some(value) = map.get(&key) {
                walk(value, rest, format!("{prefix}/{segment}"), out);
            }
        }
        Value::Array(items) => {
            if let Ok(index) = key.parse::<usize>() {
                if let Some(value) = items.get(index) {
                    walk(value, rest, format!("{prefix}/{segment}"), out);
                }
            }
        }
        _ => {}
    }
}

fn escape_segment(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

fn unescape_segment(segment: &str) -> String {
    segment.replace("~1", "/").replace("~0", "~")
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOWS_HOME: &str = r"C:\Users\me";
    const UNIX_HOME: &str = "/home/me";

    fn secret(pointer: &'static str) -> Rule {
        Rule { pointer, field: Field::Secret }
    }

    fn machine_local(pointer: &'static str) -> Rule {
        Rule { pointer, field: Field::MachineLocal }
    }

    /// The three spellings a home directory takes in a configuration file all
    /// come back exactly as they went in.
    #[test]
    fn a_home_survives_all_three_spellings() {
        for text in [
            r"C:\Users\me\.claude\settings.json",
            r"C:\\Users\\me\\.claude\\settings.json",
            "C:/Users/me/.claude/settings.json",
        ] {
            let tokenised = to_token_with(text, WINDOWS_HOME, true);
            assert!(tokenised.contains(HOME_TOKEN), "{text} was not tokenised");
            assert!(!tokenised.contains("Users"), "{text} left a home behind: {tokenised}");
            assert_eq!(from_token(&tokenised, WINDOWS_HOME), text);
        }
    }

    /// The spelling is taken from the character after the token, so a JSON file
    /// gets its backslashes doubled and a slashed one does not.
    #[test]
    fn a_token_is_expanded_in_the_spelling_that_follows_it() {
        assert_eq!(
            from_token(r"${BOITE_HOME}\\.claude", WINDOWS_HOME),
            r"C:\\Users\\me\\.claude"
        );
        assert_eq!(from_token(r"${BOITE_HOME}\.claude", WINDOWS_HOME), r"C:\Users\me\.claude");
        assert_eq!(from_token("${BOITE_HOME}/.claude", WINDOWS_HOME), "C:/Users/me/.claude");
        assert_eq!(from_token("${BOITE_HOME}", WINDOWS_HOME), WINDOWS_HOME);
    }

    /// A unix home has one spelling, and it round-trips like the others.
    #[test]
    fn a_unix_home_round_trips() {
        let text = "/home/me/.agents/AGENTS.md and /home/me/.claude";
        let tokenised = to_token_with(text, UNIX_HOME, false);
        assert!(!tokenised.contains("/home/me"));
        assert_eq!(from_token(&tokenised, UNIX_HOME), text);
    }

    /// A configuration that spells the drive in lower case is real, and on
    /// Windows it has to tokenise too.
    #[test]
    fn a_windows_home_is_matched_regardless_of_case() {
        let text = r"c:\users\ME\.claude";
        assert!(to_token_with(text, WINDOWS_HOME, true).starts_with(HOME_TOKEN));
        assert!(!to_token_with(text, WINDOWS_HOME, false).contains(HOME_TOKEN));
    }

    /// Only the prefix goes. What follows a home is part of the path and must
    /// arrive on the other machine unchanged.
    #[test]
    fn only_the_prefix_is_replaced() {
        assert_eq!(
            to_token_with(r"C:\Users\me\.claude\plugins\cache", WINDOWS_HOME, true),
            r"${BOITE_HOME}\.claude\plugins\cache"
        );
    }

    #[test]
    fn a_secret_becomes_a_placeholder_that_names_its_own_field() {
        let text = r#"{"mcpServers":{"github":{"headers":{"Authorization":"Bearer 0123456789"}}}}"#;
        let out = redact(text, &[secret("/mcpServers/*/headers/Authorization")]);
        assert_eq!(
            out.text,
            r#"{"mcpServers":{"github":{"headers":{"Authorization":"__BOITE_SECRET:/mcpServers/github/headers/Authorization__"}}}}"#
        );
        assert_eq!(out.applied.len(), 1);
        assert_eq!(out.applied[0].pointer, "/mcpServers/github/headers/Authorization");
        assert!(out.skipped.is_empty());
    }

    /// The value is swapped wherever it appears, not only where the rule found
    /// it: a credential repeated in a second field is the same credential.
    #[test]
    fn every_occurrence_of_a_value_goes() {
        let text = r#"{"a":{"headers":{"Authorization":"Bearer 0123456789"}},"note":"Bearer 0123456789"}"#;
        let out = redact(text, &[secret("/a/headers/Authorization")]);
        assert!(!out.text.contains("0123456789"), "{}", out.text);
    }

    /// The wildcard covers a file with several servers without naming one.
    #[test]
    fn a_wildcard_pointer_reaches_every_server() {
        let text = r#"{"mcpServers":{"one":{"headers":{"Authorization":"aaaaaaaaaa"}},"two":{"headers":{"Authorization":"bbbbbbbbbb"}}}}"#;
        let out = redact(text, &[secret("/mcpServers/*/headers/Authorization")]);
        assert_eq!(out.applied.len(), 2);
        assert!(!out.text.contains("aaaaaaaaaa"));
        assert!(!out.text.contains("bbbbbbbbbb"));
    }

    /// The mechanism swaps a value's own text, and a number has none. Named
    /// rather than guessed at.
    #[test]
    fn a_pointer_at_a_non_string_is_skipped_and_named() {
        let text = r#"{"port":8080}"#;
        let out = redact(text, &[secret("/port")]);
        assert!(out.applied.is_empty());
        assert_eq!(out.skipped[0].reason, Reason::NotAString);
    }

    /// A short value in a config is not a credential, and replacing it blindly
    /// would corrupt text that happens to read the same.
    #[test]
    fn a_value_shorter_than_eight_characters_is_refused() {
        let text = r#"{"token":"abc"}"#;
        let out = redact(text, &[secret("/token")]);
        assert!(out.applied.is_empty());
        assert_eq!(out.skipped[0].reason, Reason::TooShort);
    }

    #[test]
    fn a_pointer_that_reaches_nothing_is_named() {
        let out = redact(r#"{"a":1}"#, &[secret("/b/c")]);
        assert_eq!(out.skipped[0].reason, Reason::NotFound);
    }

    /// A pull puts back what this machine already had, rather than blanking it.
    #[test]
    fn a_pull_keeps_the_value_this_machine_already_had() {
        let incoming = r#"{"mcpServers":{"github":{"headers":{"Authorization":"__BOITE_SECRET:/mcpServers/github/headers/Authorization__"}}}}"#;
        let local = r#"{"mcpServers":{"github":{"headers":{"Authorization":"Bearer mine-9999"}}}}"#;
        let out = restore(incoming, Some(local));
        assert!(out.text.contains("Bearer mine-9999"), "{}", out.text);
        assert!(!out.text.contains("__BOITE_SECRET"));
        assert!(out.needed.is_empty());
    }

    /// A fresh machine has nothing to put back. The placeholder stays, so the
    /// file is still valid JSON and the value names where it came from.
    #[test]
    fn a_pull_with_no_local_value_leaves_the_placeholder_and_reports_it() {
        let incoming = r#"{"mcpServers":{"github":{"headers":{"Authorization":"__BOITE_SECRET:/mcpServers/github/headers/Authorization__"}}}}"#;
        let out = restore(incoming, None);
        assert!(out.text.contains("__BOITE_SECRET"));
        assert!(serde_json::from_str::<Value>(&out.text).is_ok(), "left invalid JSON");
        assert_eq!(out.needed.len(), 1);
        assert_eq!(out.needed[0].field, Field::Secret);
    }

    /// The whole point of keying the placeholder on the field rather than on the
    /// value: two machines with different credentials produce the same bytes, so
    /// a secret can never be the reason the merge tool opens.
    #[test]
    fn two_machines_with_different_secrets_produce_the_same_bytes() {
        let rules = [secret("/mcpServers/*/headers/Authorization")];
        let one = r#"{"mcpServers":{"github":{"headers":{"Authorization":"Bearer aaaaaaaaaa"}}}}"#;
        let two = r#"{"mcpServers":{"github":{"headers":{"Authorization":"Bearer bbbbbbbbbbbbbbbb"}}}}"#;
        assert_eq!(redact(one, &rules).text, redact(two, &rules).text);
    }

    /// The second push finds the placeholder already in place and changes
    /// nothing, which is what keeps a file from oscillating.
    #[test]
    fn redaction_is_idempotent() {
        let rules = [secret("/mcpServers/*/headers/Authorization")];
        let text = r#"{"mcpServers":{"github":{"headers":{"Authorization":"Bearer 0123456789"}}}}"#;
        let once = redact(text, &rules).text;
        let twice = redact(&once, &rules).text;
        assert_eq!(once, twice);
    }

    /// The measured `statusLine.command`: an absolute path, a plugin cache hash
    /// and a shell, inside an escaped JSON string. Tokens fix the path and
    /// nothing fixes the rest, so the field is machine-local and never travels.
    #[test]
    fn a_status_line_command_never_leaves_the_machine() {
        let text = r#"{"model":"opus","statusLine":{"type":"command","command":"powershell -File \"C:\\Users\\me\\.claude\\plugins\\cache\\x\\0d95a81d35a9\\s.ps1\""}}"#;
        let out = outbound(text, &[machine_local("/statusLine/command")], WINDOWS_HOME);
        assert!(!out.text.contains("powershell"), "{}", out.text);
        assert!(!out.text.contains("0d95a81d35a9"), "{}", out.text);
        assert!(out.text.contains("__BOITE_LOCAL:/statusLine/command__"));
        assert!(out.text.contains(r#""model":"opus""#), "the rest of the file moved");
        assert!(serde_json::from_str::<Value>(&out.text).is_ok());
    }

    /// And it comes back as this machine's own, not the other machine's.
    #[test]
    fn a_machine_local_field_is_restored_from_here() {
        let rules = [machine_local("/statusLine/command")];
        let local = r#"{"statusLine":{"command":"pwsh -File local-one.ps1"}}"#;
        let travelled = redact(r#"{"statusLine":{"command":"bash other-machine.sh"}}"#, &rules).text;
        let out = restore(&travelled, Some(local));
        assert!(out.text.contains("local-one.ps1"), "{}", out.text);
        assert!(!out.text.contains("other-machine"));
    }

    /// The file that pins the no-reserialising rule: comments, a trailing comma
    /// and key order all survive, because nothing ever parsed it.
    #[test]
    fn a_jsonc_file_keeps_its_comments() {
        let text = "// User settings\n{\n  \"zeta\": 1,\n  // a note about the theme\n  \"theme\": \"dark\",\n}\n";
        let out = outbound(text, &[], UNIX_HOME);
        assert_eq!(out.text, text);
        assert_eq!(inbound(&out.text, Some(text), UNIX_HOME).text, text);
    }

    /// A file that declares a rule and is not JSON is reported, not refused: it
    /// still syncs, and the caller can say nothing was redacted.
    #[test]
    fn a_rule_on_an_unparsable_file_is_reported_and_the_file_still_travels() {
        let text = "{ \"a\": 1, // trailing comment\n}";
        let out = redact(text, &[secret("/a")]);
        assert_eq!(out.text, text);
        assert_eq!(out.skipped[0].reason, Reason::NotJson);
    }

    /// Redaction runs before tokenisation, so a secret containing a home path
    /// travels as one placeholder rather than as a tokenised fragment.
    #[test]
    fn a_secret_holding_a_home_path_travels_whole() {
        let text = r#"{"key":"/home/me/.ssh/id_ed25519_deploy"}"#;
        let out = outbound(text, &[secret("/key")], UNIX_HOME);
        assert!(out.text.contains("__BOITE_SECRET:/key__"));
        assert!(!out.text.contains(HOME_TOKEN), "{}", out.text);
    }

    /// A key holding the terminator would make a placeholder nobody can read
    /// back, so it is refused rather than written.
    #[test]
    fn a_pointer_that_cannot_be_read_back_is_refused() {
        let text = r#"{"we__ird":"0123456789abcdef"}"#;
        let out = redact(text, &[secret("/we__ird")]);
        assert!(out.text.contains("0123456789abcdef"));
        assert_eq!(out.skipped[0].reason, Reason::PointerNotRepresentable);
    }

    /// A key with a slash in it is escaped into the pointer and found again by
    /// it, or the placeholder would name a field that does not exist.
    #[test]
    fn a_key_with_a_slash_survives_the_pointer() {
        let text = r#"{"mcpServers":{"acme/prod":{"headers":{"Authorization":"Bearer 0123456789"}}}}"#;
        let out = redact(text, &[secret("/mcpServers/*/headers/Authorization")]);
        assert_eq!(out.applied[0].pointer, "/mcpServers/acme~1prod/headers/Authorization");
        let back = restore(&out.text, Some(text));
        assert!(back.text.contains("Bearer 0123456789"), "{}", back.text);
        assert!(back.needed.is_empty());
    }

    /// The whole pipeline, both ways, on a file with one of each kind of field.
    #[test]
    fn the_pipeline_round_trips() {
        let rules = [secret("/mcpServers/*/headers/Authorization"), machine_local("/statusLine/command")];
        let local = r#"{"mcpServers":{"github":{"headers":{"Authorization":"Bearer 0123456789"}}},"statusLine":{"command":"pwsh /home/me/.claude/s.ps1"},"model":"opus"}"#;
        let travelled = outbound(local, &rules, UNIX_HOME);
        assert!(!travelled.text.contains("0123456789"));
        assert!(!travelled.text.contains("/home/me"));
        let back = inbound(&travelled.text, Some(local), UNIX_HOME);
        assert_eq!(back.text, local);
        assert!(back.needed.is_empty());
    }
}
