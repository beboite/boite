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
        "{}{}.tmp",
        path.extension()
            .map(|e| format!("{}.", e.to_string_lossy()))
            .unwrap_or_default(),
        std::process::id()
    ));
    if let Err(problem) = write_private(&tmp, text) {
        let _ = std::fs::remove_file(&tmp);
        return Err(problem);
    }
    if let Err(problem) = replace_file(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(problem);
    }
    crate::provider::protect_new_file(path);
    Ok(())
}

// Windows `rename` refuses to replace an existing file. The dest here is the
// live credentials/cache/pool path, so every later write would fail without this.
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING};

        let src: Vec<u16> = from
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let dest: Vec<u16> = to
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let ok = unsafe { MoveFileExW(src.as_ptr(), dest.as_ptr(), MOVEFILE_REPLACE_EXISTING) };
        if ok == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(from, to)
    }
}

fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_text_overwrites_the_same_path() {
        let path = std::env::temp_dir().join(format!(
            "kebacc-switch-jsonio-{}-{}.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        write_text(&path, "first").expect("first write");
        write_text(&path, "second").expect("second write");
        let got = std::fs::read_to_string(&path).expect("read back");
        let _ = std::fs::remove_file(&path);
        assert_eq!(got, "second");
    }
}
