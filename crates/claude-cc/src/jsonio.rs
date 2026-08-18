use serde_json::{Map, Value};
use std::path::Path;

pub fn read(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn write(path: &Path, value: &Value) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(value)?;
    write_text(path, &text)
}

pub fn write_text(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!(
        "{}tmp",
        path.extension()
            .map(|e| format!("{}.", e.to_string_lossy()))
            .unwrap_or_default()
    ));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)?;
    crate::provider::protect_file(path);
    Ok(())
}

pub fn str_of(value: &Value, key: &str) -> Option<String> {
    match value.get(key) {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Null) | None => None,
        Some(other) => Some(other.to_string()),
    }
}

pub fn obj(value: &Value, key: &str) -> Option<Value> {
    match value.get(key) {
        Some(Value::Null) | None => None,
        Some(other) => Some(other.clone()),
    }
}

pub fn map_mut(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("just made it an object")
}

pub fn jwt_payload(token: &str) -> Option<Value> {
    use base64::engine::general_purpose::STANDARD_NO_PAD as B64;
    use base64::Engine;

    let part = token.split('.').nth(1)?;
    let body: String = part
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .filter(|c| *c != '=')
        .collect();
    let bytes = B64.decode(body.as_bytes()).ok()?;
    serde_json::from_slice(&bytes).ok()
}
