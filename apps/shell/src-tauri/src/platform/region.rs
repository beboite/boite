//! The machine's regional format, which can differ from the language its
//! interface speaks: an English Windows set to Switzerland shows 19:40 in its
//! taskbar. The webview only reports the language, so the shell reads the
//! region here and hands it to the page before any script runs; the UI formats
//! dates and clocks with it (`formatLocale` in `lib/i18n.svelte.ts`).

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Region {
    /// A BCP 47 tag such as `fr-CH`, whose region the UI keeps.
    pub(crate) locale: Option<String>,
    /// The clock the user picked, when the system says so explicitly.
    pub(crate) hour12: Option<bool>,
}

/// `window.__BOITE_REGION__`, run first by the main window (`window.rs`) and
/// the quota popup (`quota_window.rs`). A new window drawing the app UI adds
/// it to its builder; browser tabs and sign-in popups show other sites. Read
/// once, so every window formats alike until the app restarts.
pub(crate) fn script() -> String {
    static SCRIPT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SCRIPT.get_or_init(|| script_for(&read())).clone()
}

fn script_for(region: &Region) -> String {
    let value = serde_json::json!({ "locale": region.locale, "hour12": region.hour12 });
    format!("window.__BOITE_REGION__ = {value};")
}

/// `fr_CH.UTF-8` or `de_DE@euro` as a tag; `C`, `POSIX` and empty values say nothing.
#[cfg_attr(windows, allow(dead_code))]
fn posix_tag(value: &str) -> Option<String> {
    let name = value.split(['.', '@']).next()?.trim();
    if name == "C" || name == "POSIX" { return None; }
    tag(&name.replace('_', "-"))
}

/// A name shaped like a BCP 47 tag, letters, digits and `-`; anything else says nothing.
fn tag(name: &str) -> Option<String> {
    let shaped = name.chars().any(|c| c.is_ascii_alphanumeric()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    shaped.then(|| name.to_owned())
}

/// macOS reads the same variables, which a Finder launch usually leaves unset:
/// the UI then falls back to the webview's languages. A native `CFLocale` read
/// would cover it.
#[cfg(not(windows))]
fn read() -> Region {
    Region { locale: posix_locale(|name| std::env::var(name).ok()), hour12: None }
}

/// The first variable set and non-empty wins, the way libc resolves LC_TIME.
#[cfg_attr(windows, allow(dead_code))]
fn posix_locale(var: impl Fn(&str) -> Option<String>) -> Option<String> {
    ["LC_ALL", "LC_TIME", "LANG"].iter()
        .find_map(|name| var(name).filter(|value| !value.is_empty()))
        .and_then(|value| posix_tag(&value))
}

/// The user's regional format and short time pattern, both from Settings >
/// Time & language > Region, overrides included.
#[cfg(windows)]
fn read() -> Region {
    use windows_sys::Win32::Globalization::{GetLocaleInfoEx, GetUserDefaultLocaleName, LOCALE_SSHORTTIME};
    let mut name = [0u16; 85];
    // SAFETY: the buffer and its length match; the call writes a NUL-terminated name.
    let written = unsafe { GetUserDefaultLocaleName(name.as_mut_ptr(), name.len() as i32) };
    let locale = (written > 1).then(|| String::from_utf16_lossy(&name[..written as usize - 1])).as_deref().and_then(tag);
    // 80 is the documented maximum for LOCALE_SSHORTTIME, its NUL included.
    let mut pattern = [0u16; 80];
    // SAFETY: a null name is LOCALE_NAME_USER_DEFAULT; the buffer and its length match.
    let written = unsafe { GetLocaleInfoEx(std::ptr::null(), LOCALE_SSHORTTIME, pattern.as_mut_ptr(), pattern.len() as i32) };
    let pattern = (written > 1).then(|| String::from_utf16_lossy(&pattern[..written as usize - 1]));
    Region { locale, hour12: pattern.as_deref().and_then(hour12) }
}

/// `HH:mm` is a 24 hour clock, `h:mm tt` a 12 hour one; quoted text is skipped.
#[cfg_attr(not(windows), allow(dead_code))]
fn hour12(pattern: &str) -> Option<bool> {
    let mut quoted = false;
    for c in pattern.chars() {
        match c {
            '\'' => quoted = !quoted,
            'H' if !quoted => return Some(false),
            'h' if !quoted => return Some(true),
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_locales_become_tags() {
        assert_eq!(posix_tag("fr_CH.UTF-8").as_deref(), Some("fr-CH"));
        assert_eq!(posix_tag("de_DE@euro").as_deref(), Some("de-DE"));
        assert_eq!(posix_tag("C.UTF-8"), None);
        assert_eq!(posix_tag("POSIX"), None);
        assert_eq!(posix_tag("x\"y"), None);
        assert_eq!(tag("fr-CH").as_deref(), Some("fr-CH"));
        assert_eq!(tag(""), None);
        assert_eq!(tag("---"), None);
    }

    #[test]
    fn the_first_locale_variable_set_decides() {
        let env = |pairs: &'static [(&'static str, &'static str)]| move |name: &str| {
            pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| value.to_string())
        };
        assert_eq!(posix_locale(env(&[("LC_ALL", "fr_CH.UTF-8"), ("LC_TIME", "en_US.UTF-8"), ("LANG", "de_DE")])).as_deref(), Some("fr-CH"));
        assert_eq!(posix_locale(env(&[("LC_ALL", ""), ("LC_TIME", "en_GB.UTF-8"), ("LANG", "de_DE")])).as_deref(), Some("en-GB"));
        assert_eq!(posix_locale(env(&[("LANG", "de_DE.UTF-8")])).as_deref(), Some("de-DE"));
        // `C` decides too: it names no region, so LANG behind it is not read.
        assert_eq!(posix_locale(env(&[("LC_ALL", "C"), ("LANG", "fr_CH.UTF-8")])), None);
        assert_eq!(posix_locale(env(&[])), None);
    }

    #[test]
    fn windows_time_patterns_name_their_clock() {
        assert_eq!(hour12("HH:mm"), Some(false));
        assert_eq!(hour12("h:mm tt"), Some(true));
        assert_eq!(hour12("'h' HH:mm"), Some(false));
        assert_eq!(hour12("mm"), None);
    }

    #[test]
    fn the_script_is_one_assignment() {
        let value = |region: &Region| -> serde_json::Value {
            let script = script_for(region);
            let json = script.strip_prefix("window.__BOITE_REGION__ = ").and_then(|rest| rest.strip_suffix(';')).unwrap();
            serde_json::from_str(json).unwrap()
        };
        assert_eq!(value(&Region { locale: Some("fr-CH".into()), hour12: Some(false) }), serde_json::json!({ "locale": "fr-CH", "hour12": false }));
        assert_eq!(value(&Region::default()), serde_json::json!({ "locale": null, "hour12": null }));
    }
}
