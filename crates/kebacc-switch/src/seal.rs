use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;

pub const PREFIX: &str = "ccx1:";
const SECRET_ACCOUNT: &str = "kebacc-switch";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Dpapi,
    Keychain,
    Libsecret,
    None,
}

impl Backend {
    pub fn name(self) -> &'static str {
        match self {
            Backend::Dpapi => "dpapi",
            Backend::Keychain => "keychain",
            Backend::Libsecret => "libsecret",
            Backend::None => "none",
        }
    }
}

pub fn backend() -> Backend {
    if cfg!(windows) {
        return Backend::Dpapi;
    }
    if cfg!(target_os = "macos") && which("security") {
        return Backend::Keychain;
    }
    if which("secret-tool") {
        return Backend::Libsecret;
    }
    Backend::None
}

fn which(cmd: &str) -> bool {
    std::process::Command::new(cmd)
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok()
}

pub fn random_bytes(count: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; count];
    getrandom::fill(&mut bytes).expect("the OS random source is not optional");
    bytes
}

fn secret_key(create: bool) -> Option<Vec<u8>> {
    let backend = backend();
    let (tool, read, write): (&str, Vec<&str>, Vec<&str>) = match backend {
        Backend::Keychain => (
            "security",
            vec![
                "find-generic-password",
                "-s",
                SECRET_ACCOUNT,
                "-a",
                SECRET_ACCOUNT,
                "-w",
            ],
            vec![
                "add-generic-password",
                "-U",
                "-s",
                SECRET_ACCOUNT,
                "-a",
                SECRET_ACCOUNT,
                "-w",
            ],
        ),
        Backend::Libsecret => (
            "secret-tool",
            vec![
                "lookup",
                "service",
                SECRET_ACCOUNT,
                "account",
                SECRET_ACCOUNT,
            ],
            vec![
                "store",
                "--label=kebacc-switch",
                "service",
                SECRET_ACCOUNT,
                "account",
                SECRET_ACCOUNT,
            ],
        ),
        _ => return None,
    };

    if let Ok(out) = std::process::Command::new(tool).args(&read).output() {
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !text.is_empty() {
            if let Ok(key) = B64.decode(text.as_bytes()) {
                return Some(key);
            }
        }
    }
    if !create {
        return None;
    }
    let key = random_bytes(32);
    let b64 = B64.encode(&key);
    let stored = match backend {
        Backend::Keychain => write_stdin(
            tool,
            &write,
            &format!(
                "{b64}
{b64}
"
            ),
        ),
        _ => write_stdin(tool, &write, &b64),
    };
    if stored {
        Some(key)
    } else {
        None
    }
}

pub fn secret_via_stdin(tool: &str, args: &[&str], text: &str) -> bool {
    write_stdin(tool, args, text)
}

fn write_stdin(tool: &str, args: &[&str], text: &str) -> bool {
    use std::io::Write;
    let child = std::process::Command::new(tool)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    let Ok(mut child) = child else { return false };
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(text.as_bytes());
    }
    child.stdin.take();
    child.wait().map(|s| s.success()).unwrap_or(false)
}

pub fn wrap_bytes(plain: &[u8]) -> Option<Vec<u8>> {
    dpapi_protect(plain)
}

pub fn unwrap_bytes(blob: &[u8]) -> Option<Vec<u8>> {
    dpapi_unprotect(blob)
}

pub fn protect(text: &str) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    if let Some(blob) = dpapi_protect(text.as_bytes()) {
        return Some(format!("{PREFIX}{}", B64.encode(blob)));
    }
    let key = secret_key(true)?;
    let sealed = aes_seal(&key, text.as_bytes())?;
    Some(format!("{PREFIX}{}", B64.encode(sealed)))
}

pub fn unprotect(sealed: &str) -> Option<String> {
    if sealed.is_empty() {
        return None;
    }
    let Some(body) = sealed.strip_prefix(PREFIX) else {
        return unprotect_legacy(sealed);
    };
    let blob = B64.decode(body.as_bytes()).ok()?;
    if cfg!(windows) {
        return String::from_utf8(dpapi_unprotect(&blob)?).ok();
    }
    let key = secret_key(false)?;
    String::from_utf8(aes_open(&key, &blob)?).ok()
}

fn unprotect_legacy(sealed: &str) -> Option<String> {
    let base64ish = !sealed.is_empty()
        && sealed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=');
    if !cfg!(windows) || !base64ish {
        return Some(sealed.to_string());
    }
    match B64
        .decode(sealed.as_bytes())
        .ok()
        .and_then(|blob| dpapi_unprotect(&blob))
        .and_then(|plain| String::from_utf8(plain).ok())
    {
        Some(plain) => Some(plain),
        None => Some(sealed.to_string()),
    }
}

fn aes_seal(key: &[u8], plain: &[u8]) -> Option<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes256Gcm, Nonce};

    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let nonce = random_bytes(12);
    let sealed = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plain,
                aad: &[],
            },
        )
        .ok()?;
    let (body, tag) = sealed.split_at(sealed.len() - 16);
    let mut out = Vec::with_capacity(28 + body.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(tag);
    out.extend_from_slice(body);
    Some(out)
}

fn aes_open(key: &[u8], blob: &[u8]) -> Option<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes256Gcm, Nonce};

    if blob.len() <= 28 {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let mut joined = Vec::with_capacity(blob.len() - 12);
    joined.extend_from_slice(&blob[28..]);
    joined.extend_from_slice(&blob[12..28]);
    cipher
        .decrypt(
            Nonce::from_slice(&blob[..12]),
            Payload {
                msg: &joined,
                aad: &[],
            },
        )
        .ok()
}

#[cfg(windows)]
fn dpapi_protect(plain: &[u8]) -> Option<Vec<u8>> {
    dpapi(plain, true)
}

#[cfg(windows)]
fn dpapi_unprotect(blob: &[u8]) -> Option<Vec<u8>> {
    dpapi(blob, false)
}

#[cfg(windows)]
fn dpapi(input: &[u8], seal: bool) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    let src = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr() as *mut u8,
    };
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if seal {
            CryptProtectData(
                &src,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
                &mut out,
            )
        } else {
            CryptUnprotectData(
                &src,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
                &mut out,
            )
        }
    };
    if ok == 0 || out.pbData.is_null() {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
    unsafe { LocalFree(out.pbData as *mut std::ffi::c_void) };
    Some(bytes)
}

#[cfg(not(windows))]
fn dpapi_protect(_plain: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(not(windows))]
fn dpapi_unprotect(_blob: &[u8]) -> Option<Vec<u8>> {
    None
}
