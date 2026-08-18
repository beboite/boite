use crate::jsonio;
use crate::provider::Provider;
use crate::seal;
use crate::term::Color;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const POOL_VERSION: u64 = 2;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Trust {
    Trusted,
    Changed,
    Unknown,
    NoKey,
}

impl Trust {
    pub fn verdict(self) -> (&'static str, Color) {
        match self {
            Trust::Trusted => ("trusted", Color::Dim),
            Trust::Changed => ("CHANGED", Color::Red),
            Trust::NoKey => ("unverified", Color::Yellow),
            Trust::Unknown => ("unknown", Color::Yellow),
        }
    }
}

pub struct Entry {
    pub email: String,
    pub file: PathBuf,
    pub snapshot: Value,
    pub creds: Option<String>,
    pub identity: Option<Value>,
    pub cache: Option<Value>,
    pub protected: bool,
    pub trust: Trust,
}

impl Entry {
    pub fn file_name(&self) -> String {
        self.file
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
    }
}

pub struct Pool<'a> {
    provider: &'a Provider,
}

impl<'a> Pool<'a> {
    pub fn new(provider: &'a Provider) -> Self {
        Self { provider }
    }

    fn key_file(&self) -> PathBuf {
        self.provider.store.join(".pool.key")
    }

    fn manifest_file(&self) -> PathBuf {
        self.provider.store.join(".pool.json")
    }

    pub fn key(&self, create: bool) -> Option<Vec<u8>> {
        let path = self.key_file();
        if path.exists() {
            let wrapped = std::fs::read(&path).ok()?;
            if cfg!(windows) {
                return seal::unwrap_bytes(&wrapped);
            }
            let sealed = String::from_utf8(wrapped).ok()?;
            let plain = seal::unprotect(&sealed)?;
            return B64.decode(plain.as_bytes()).ok();
        }
        if !create {
            return None;
        }
        std::fs::create_dir_all(&self.provider.store).ok()?;
        crate::provider::protect_dir(&self.provider.store);
        let key = seal::random_bytes(32);
        if cfg!(windows) {
            std::fs::write(&path, seal::wrap_bytes(&key)?).ok()?;
        } else {
            std::fs::write(&path, seal::protect(&B64.encode(&key))?.as_bytes()).ok()?;
        }
        crate::provider::protect_file(&path);
        Some(key)
    }

    pub fn entries(&self) -> Vec<Entry> {
        let key = self.key(false);
        let mut files: Vec<PathBuf> = match std::fs::read_dir(&self.provider.store) {
            Ok(dir) => dir
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.is_file()
                        && p.extension().map(|e| e == "json").unwrap_or(false)
                        && !p
                            .file_name()
                            .map(|n| n.to_string_lossy().starts_with('.'))
                            .unwrap_or(true)
                })
                .collect(),
            Err(_) => return Vec::new(),
        };
        files.sort();

        files
            .into_iter()
            .filter_map(|file| {
                let snapshot = jsonio::read(&file)?;
                let name = file.file_name()?.to_string_lossy().to_string();
                Some(Entry {
                    email: jsonio::str_of(&snapshot, "email").unwrap_or_default(),
                    creds: snapshot_creds(&snapshot),
                    identity: identity_of(&snapshot),
                    cache: jsonio::obj(&snapshot, "usageCache"),
                    protected: snapshot.get("credentialsProtected").is_some(),
                    trust: self.verify(key.as_deref(), &name, &snapshot),
                    file,
                    snapshot,
                })
            })
            .collect()
    }

    pub fn manifest(&self) -> Option<Value> {
        jsonio::read(&self.manifest_file())
    }

    pub fn register(&self, file_name: &str, snapshot: &Value) -> bool {
        let Some(key) = self.key(true) else {
            return false;
        };
        let (uuid, email) = pool_identity(snapshot);
        let Some(uuid) = uuid else { return false };
        let cred_hash = cred_hash(snapshot_creds(snapshot).as_deref());
        let stamp = stamp(&key, file_name, &email, &uuid, Some(&cred_hash));

        let mut manifest = self
            .manifest()
            .unwrap_or_else(|| json!({ "version": POOL_VERSION, "accounts": Map::new() }));
        let map = jsonio::map_mut(&mut manifest);
        map.insert("version".into(), json!(POOL_VERSION));
        if !map.get("accounts").map(Value::is_object).unwrap_or(false) {
            map.insert("accounts".into(), Value::Object(Map::new()));
        }
        let accounts = map
            .get_mut("accounts")
            .and_then(Value::as_object_mut)
            .expect("just ensured accounts is an object");
        accounts.insert(
            file_name.to_string(),
            json!({
                "email": email,
                "accountUuid": uuid,
                "credHash": cred_hash,
                "stamp": stamp,
                "registered": crate::usage::now_iso(),
            }),
        );
        jsonio::write(&self.manifest_file(), &manifest).is_ok()
    }

    pub fn unregister(&self, file_name: &str) {
        let Some(mut manifest) = self.manifest() else {
            return;
        };
        let Some(accounts) = manifest.get_mut("accounts").and_then(Value::as_object_mut) else {
            return;
        };
        if accounts.remove(file_name).is_none() {
            return;
        }
        let _ = jsonio::write(&self.manifest_file(), &manifest);
    }

    fn verify(&self, key: Option<&[u8]>, file_name: &str, snapshot: &Value) -> Trust {
        let Some(key) = key else { return Trust::NoKey };
        let Some(manifest) = self.manifest() else {
            return Trust::Unknown;
        };
        let Some(entry) = manifest.get("accounts").and_then(|a| a.get(file_name)) else {
            return Trust::Unknown;
        };
        let recorded_email = jsonio::str_of(entry, "email").unwrap_or_default();
        let recorded_uuid = jsonio::str_of(entry, "accountUuid").unwrap_or_default();
        let recorded_stamp = jsonio::str_of(entry, "stamp").unwrap_or_default();
        let (uuid, email) = pool_identity(snapshot);
        let uuid = uuid.unwrap_or_default();
        if !email.eq_ignore_ascii_case(&recorded_email) {
            return Trust::Changed;
        }
        let cred_hash = cred_hash(snapshot_creds(snapshot).as_deref());

        let expected = stamp(
            key,
            file_name,
            &recorded_email,
            &recorded_uuid,
            Some(&cred_hash),
        );
        if same_stamp(&recorded_stamp, &expected) && uuid == recorded_uuid {
            return Trust::Trusted;
        }

        for legacy in [None, Some("none")] {
            let old = stamp(key, file_name, &recorded_email, &recorded_uuid, legacy);
            if !same_stamp(&recorded_stamp, &old) || uuid != recorded_uuid {
                continue;
            }
            self.register(file_name, snapshot);
            return Trust::Trusted;
        }
        Trust::Changed
    }
}

pub fn snapshot_creds(snapshot: &Value) -> Option<String> {
    if let Some(sealed) = jsonio::str_of(snapshot, "credentialsProtected") {
        return seal::unprotect(&sealed);
    }
    match snapshot.get("credentials") {
        Some(value) if !value.is_null() => serde_json::to_string(value).ok(),
        _ => None,
    }
}

pub fn identity_of(snapshot: &Value) -> Option<Value> {
    match snapshot.get("oauthAccountRaw") {
        Some(Value::String(text)) => serde_json::from_str(text).ok(),
        Some(Value::Null) | None => None,
        Some(other) => Some(other.clone()),
    }
}

fn pool_identity(snapshot: &Value) -> (Option<String>, String) {
    let mut uuid = None;
    let mut email = None;
    if let Some(account) = identity_of(snapshot) {
        uuid = jsonio::str_of(&account, "accountUuid");
        email = jsonio::str_of(&account, "emailAddress");
    }
    if email.is_none() {
        email = jsonio::str_of(snapshot, "email");
    }
    (uuid, email.unwrap_or_default())
}

fn sha256_hex(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn cred_hash(creds_raw: Option<&str>) -> String {
    let Some(raw) = creds_raw else {
        return "none".into();
    };
    let Ok(creds) = serde_json::from_str::<Value>(raw) else {
        return "none".into();
    };
    if let Some(oauth) = creds.get("claudeAiOauth").filter(|v| !v.is_null()) {
        return sha256_hex(&format!(
            "{}|{}|{}",
            jsonio::str_of(oauth, "accessToken").unwrap_or_default(),
            jsonio::str_of(oauth, "refreshToken").unwrap_or_default(),
            jsonio::str_of(oauth, "expiresAt").unwrap_or_default(),
        ));
    }
    if let Some(tokens) = creds.get("tokens").filter(|v| !v.is_null()) {
        return sha256_hex(&format!(
            "{}|{}|{}",
            jsonio::str_of(tokens, "access_token").unwrap_or_default(),
            jsonio::str_of(tokens, "refresh_token").unwrap_or_default(),
            jsonio::str_of(tokens, "account_id").unwrap_or_default(),
        ));
    }
    if let Some(key) = jsonio::str_of(&creds, "OPENAI_API_KEY") {
        return sha256_hex(&key);
    }
    "none".into()
}

fn stamp(key: &[u8], file_name: &str, email: &str, uuid: &str, cred_hash: Option<&str>) -> String {
    let payload = match cred_hash {
        Some(hash) => format!("{file_name}|{email}|{uuid}|{hash}"),
        None => format!("{file_name}|{email}|{uuid}"),
    };
    let mut mac = <Hmac<Sha256>>::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(payload.as_bytes());
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn new_snapshot(
    email: &str,
    creds_raw: &str,
    identity: Option<&Value>,
    usage_cache: Option<&Value>,
    saved_at: Option<&str>,
) -> (Value, bool) {
    let mut entry = Map::new();
    entry.insert("email".into(), json!(email));
    entry.insert(
        "savedAt".into(),
        json!(saved_at
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(crate::usage::now_iso)),
    );
    let sealed = seal::protect(creds_raw);
    let protected = sealed.is_some();
    match sealed {
        Some(text) => {
            entry.insert("credentialsProtected".into(), json!(text));
        }
        None => {
            let parsed: Value = serde_json::from_str(creds_raw).unwrap_or(Value::Null);
            entry.insert("credentials".into(), parsed);
        }
    }
    if let Some(identity) = identity {
        entry.insert("oauthAccountRaw".into(), identity.clone());
    }
    if let Some(cache) = usage_cache {
        entry.insert("usageCache".into(), cache.clone());
    }
    (Value::Object(entry), protected)
}

pub fn snapshot_files(store: &Path) -> Vec<PathBuf> {
    match std::fs::read_dir(store) {
        Ok(dir) => dir.filter_map(|e| e.ok()).map(|e| e.path()).collect(),
        Err(_) => Vec::new(),
    }
}

pub fn plain_snapshots(store: &Path) -> Option<Vec<(PathBuf, Value)>> {
    if !store.is_dir() {
        return None;
    }
    let mut files: Vec<PathBuf> = snapshot_files(store)
        .into_iter()
        .filter(|file| {
            let name = file.file_name().unwrap_or_default().to_string_lossy();
            name.ends_with(".json") && !name.starts_with('.')
        })
        .collect();
    files.sort();
    Some(
        files
            .into_iter()
            .map(|file| {
                let snapshot = crate::jsonio::read(&file).unwrap_or(Value::Null);
                (file, snapshot)
            })
            .collect(),
    )
}

fn same_stamp(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}
