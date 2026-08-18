use crate::jsonio;
use crate::lock;
use crate::provider::Provider;
use crate::seal;
use serde_json::{json, Value};
use std::path::PathBuf;

pub fn creds_raw(provider: &Provider) -> Option<String> {
    let file = provider.cred_file();
    if provider.uses_keychain && !file.exists() {
        let service = provider.keychain_service?;
        let out = std::process::Command::new("security")
            .args(["find-generic-password", "-s", service, "-w"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return (!text.is_empty()).then_some(text);
    }
    let text = std::fs::read_to_string(&file).ok()?;
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

pub fn set_creds_raw(provider: &Provider, raw: &str) -> std::io::Result<()> {
    let file = provider.cred_file();
    jsonio::write_text(&file, raw)?;
    if provider.uses_keychain {
        if let Some(service) = provider.keychain_service {
            let user = std::env::var("USER").unwrap_or_default();
            seal::secret_via_stdin(
                "security",
                &[
                    "add-generic-password",
                    "-U",
                    "-s",
                    service,
                    "-a",
                    &user,
                    "-w",
                ],
                &format!(
                    "{raw}
{raw}
"
                ),
            );
        }
    }
    Ok(())
}

pub fn identity(provider: &Provider) -> Option<Value> {
    if provider.is_codex() {
        let raw = creds_raw(provider)?;
        let creds: Value = serde_json::from_str(&raw).ok()?;
        return codex_identity(&creds);
    }
    let config = jsonio::read(&provider.config_file())?;
    jsonio::obj(&config, "oauthAccount")
}

pub fn codex_identity(creds: &Value) -> Option<Value> {
    let tokens = creds.get("tokens").filter(|v| !v.is_null())?;
    let mut email = None;
    let mut uuid = jsonio::str_of(tokens, "account_id");
    if let Some(claims) = jsonio::str_of(tokens, "id_token").and_then(|t| jsonio::jwt_payload(&t)) {
        email = jsonio::str_of(&claims, "email");
        if uuid.is_none() {
            uuid = claims
                .get("https://api.openai.com/auth")
                .and_then(|auth| jsonio::str_of(auth, "chatgpt_account_id"));
        }
    }
    if email.is_none() && uuid.is_none() {
        return None;
    }
    Some(json!({ "emailAddress": email, "accountUuid": uuid }))
}

pub fn set_identity(provider: &Provider, identity: &Value) {
    if provider.is_codex() {
        return;
    }
    let path = provider.config_file();
    if !path.exists() {
        let _ = jsonio::write(&path, &json!({ "oauthAccount": identity }));
        return;
    }
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let block = serde_json::to_string(identity).unwrap_or_else(|_| "{}".into());

    let updated = match find_member(&text, "oauthAccount") {
        Some((start, end)) => {
            let mut out = String::with_capacity(text.len() + block.len());
            out.push_str(&text[..start]);
            out.push_str(&block);
            out.push_str(&text[end..]);
            out
        }
        None => {
            let Some(open) = text.find('{') else { return };
            let rest = text[open + 1..].trim_start();
            let comma = if rest.starts_with('}') { "" } else { "," };
            let mut out = String::with_capacity(text.len() + block.len() + 20);
            out.push_str(&text[..=open]);
            out.push_str("\"oauthAccount\":");
            out.push_str(&block);
            out.push_str(comma);
            out.push_str(&text[open + 1..]);
            out
        }
    };
    let _ = jsonio::write_text(&path, &updated);
}

fn find_member(text: &str, name: &str) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut i = skip_space(bytes, 0);
    if i >= bytes.len() || bytes[i] != b'{' {
        return None;
    }
    i += 1;
    loop {
        i = skip_space(bytes, i);
        if i >= bytes.len() || bytes[i] == b'}' {
            return None;
        }
        if bytes[i] != b'"' {
            return None;
        }
        let (key, after) = read_string(bytes, i)?;
        i = skip_space(bytes, after);
        if i >= bytes.len() || bytes[i] != b':' {
            return None;
        }
        i = skip_space(bytes, i + 1);
        let start = i;
        i = skip_value(bytes, i)?;
        if key == name {
            return Some((start, i));
        }
        i = skip_space(bytes, i);
        match bytes.get(i) {
            Some(b',') => i += 1,
            _ => return None,
        }
    }
}

fn skip_space(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

fn read_string(bytes: &[u8], i: usize) -> Option<(String, usize)> {
    let mut end = i + 1;
    while end < bytes.len() && bytes[end] != b'"' {
        if bytes[end] == b'\\' {
            end += 1;
        }
        end += 1;
    }
    if end >= bytes.len() {
        return None;
    }
    let text = std::str::from_utf8(&bytes[i + 1..end]).ok()?.to_string();
    Some((text, end + 1))
}

fn skip_value(bytes: &[u8], i: usize) -> Option<usize> {
    match *bytes.get(i)? {
        b'"' => read_string(bytes, i).map(|(_, end)| end),
        open @ (b'{' | b'[') => {
            let close = if open == b'{' { b'}' } else { b']' };
            let mut depth = 0usize;
            let mut at = i;
            while at < bytes.len() {
                match bytes[at] {
                    b'"' => at = read_string(bytes, at)?.1 - 1,
                    b if b == open => depth += 1,
                    b if b == close => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(at + 1);
                        }
                    }
                    _ => {}
                }
                at += 1;
            }
            None
        }
        _ => {
            let mut at = i;
            while at < bytes.len() && !matches!(bytes[at], b',' | b'}' | b']') {
                at += 1;
            }
            (at > i).then_some(at)
        }
    }
}

pub fn backup_creds(provider: &Provider) {
    let Some(raw) = creds_raw(provider) else {
        return;
    };
    let dir = provider.backup_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    crate::provider::protect_dir(&dir);
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let (name, body) = match seal::protect(&raw) {
        Some(sealed) => (format!("creds-{stamp}.ccx"), sealed),
        None => (format!("creds-{stamp}.json"), raw),
    };
    let file = dir.join(name);
    if std::fs::write(&file, body).is_err() {
        return;
    }
    crate::provider::protect_file(&file);
    for old in backup_files(provider).into_iter().skip(3) {
        let _ = std::fs::remove_file(old);
    }
}

pub fn backup_files(provider: &Provider) -> Vec<PathBuf> {
    let mut files: Vec<(std::time::SystemTime, PathBuf)> =
        match std::fs::read_dir(provider.backup_dir()) {
            Ok(dir) => dir
                .filter_map(|e| e.ok())
                .filter(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    name.starts_with("creds-") || name.starts_with("backup-")
                })
                .filter_map(|e| {
                    let at = e.metadata().and_then(|m| m.modified()).ok()?;
                    Some((at, e.path()))
                })
                .collect(),
            Err(_) => return Vec::new(),
        };
    files.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
    files.into_iter().map(|(_, p)| p).collect()
}

pub struct Backup {
    pub raw: String,
    pub at: chrono::DateTime<chrono::Local>,
}

pub fn newest_backup(provider: &Provider) -> Option<Backup> {
    let file = backup_files(provider).into_iter().next()?;
    let text = std::fs::read_to_string(&file).ok()?.trim().to_string();
    let raw = if text.starts_with('{') {
        text
    } else {
        seal::unprotect(&text)?
    };
    if !raw.starts_with('{') {
        return None;
    }
    let at = std::fs::metadata(&file)
        .and_then(|m| m.modified())
        .map(chrono::DateTime::<chrono::Local>::from)
        .unwrap_or_else(|_| chrono::Local::now());
    Some(Backup { raw, at })
}

pub fn activate(provider: &Provider, entry: &crate::pool::Entry) -> Result<(), String> {
    let Some(creds) = entry.creds.as_deref() else {
        return Err(format!(
            "The credentials for {} could not be read back.",
            entry.email
        ));
    };
    lock::locked(lock::CRED_SWAP, || {
        backup_creds(provider);
        set_creds_raw(provider, creds)
            .map_err(|e| format!("Could not write the credentials: {e}"))?;
        if let Some(identity) = entry.identity.as_ref() {
            set_identity(provider, identity);
        }
        Ok(())
    })?
}

#[cfg(test)]
mod tests {
    use super::find_member;

    #[test]
    fn finds_a_member_of_the_root_object() {
        let text = r#"{"a":1,"oauthAccount":{"emailAddress":"one@example.com"},"b":2}"#;
        let (start, end) = find_member(text, "oauthAccount").unwrap();
        assert_eq!(&text[start..end], r#"{"emailAddress":"one@example.com"}"#);
    }

    #[test]
    fn ignores_the_same_name_deeper_in_the_file() {
        let text = r#"{"projects":{"x":{"history":[{"display":"\"oauthAccount\": {\"emailAddress\": \"nobody\"}"}]}},"oauthAccount":{"emailAddress":"real@example.com"}}"#;
        let (start, end) = find_member(text, "oauthAccount").unwrap();
        assert_eq!(&text[start..end], r#"{"emailAddress":"real@example.com"}"#);
    }

    #[test]
    fn a_member_that_is_not_there_is_not_invented() {
        let text = r#"{"projects":{"oauthAccount":{"emailAddress":"nested@example.com"}}}"#;
        assert!(find_member(text, "oauthAccount").is_none());
    }

    #[test]
    fn finds_the_account_in_the_real_config() {
        let path = crate::provider::home().join(".claude.json");
        let Ok(text) = std::fs::read_to_string(&path) else {
            return;
        };
        let Some(expected) = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|config| crate::jsonio::obj(&config, "oauthAccount"))
        else {
            return;
        };
        let (start, end) = find_member(&text, "oauthAccount").expect("the member is in the file");
        let spliced: serde_json::Value =
            serde_json::from_str(&text[start..end]).expect("the range is one JSON value");
        assert_eq!(spliced, expected);
    }

    #[test]
    fn replaces_a_member_of_any_shape() {
        let text = r#"{"oauthAccount":null,"b":2}"#;
        let (start, end) = find_member(text, "oauthAccount").unwrap();
        assert_eq!(&text[start..end], "null");
    }
}
