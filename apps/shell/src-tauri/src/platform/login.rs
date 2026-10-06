//! Starting the shell when the user signs in: a `Run` value on Windows, an XDG
//! autostart entry on Linux, a LaunchAgent on macOS. Each one runs this
//! executable with `LOGIN_ARG`, which keeps the window in the tray.
//!
//! Every path is quoted. A per-user install sits under the user's profile, and
//! a profile name with a space would otherwise start the wrong program or none.

use std::path::{Path, PathBuf};

/// The argument a login start carries. Read by `crate::autostart`.
pub(crate) const LOGIN_ARG: &str = "--autostart";

/// What this executable registers, and under which name.
pub(crate) struct LoginItem {
    /// The `Run` value on Windows. The product name, the one the NSIS
    /// uninstaller deletes (`installer.nsi`, "Removes the Autostart entry").
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    pub(crate) name: String,
    /// The bundle identifier: the autostart file name and LaunchAgent label.
    pub(crate) identifier: String,
    /// The program the entry starts.
    pub(crate) program: PathBuf,
}

impl LoginItem {
    /// True when the entry exists, starts this program, and the user did not
    /// turn it off elsewhere (Task Manager's Startup tab on Windows).
    pub(crate) fn enabled(&self) -> Result<bool, String> {
        backend::enabled(self)
    }

    pub(crate) fn set(&self, enabled: bool) -> Result<(), String> {
        if enabled { backend::enable(self) } else { backend::disable(self) }
    }
}

/// The program a login entry should start: on Linux an AppImage is the file
/// `$APPIMAGE` names, since `current_exe` is a mount that disappears with it.
pub(crate) fn login_program() -> Result<PathBuf, String> {
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(image) = std::env::var_os("APPIMAGE").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(image));
    }
    std::env::current_exe().map_err(|error| format!("the shell's own executable path is unknown: {error}"))
}

/// `"<program>" --autostart`, the Windows command line. A Windows path cannot
/// contain a double quote, so quoting it whole is enough.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn windows_command(program: &Path) -> String {
    format!("\"{}\" {LOGIN_ARG}", program.display())
}

/// Task Manager's Startup tab writes a binary value under `StartupApproved`
/// whose first byte is odd when the user turned the entry off.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn approved(value: Option<&[u8]>) -> bool {
    value.and_then(|bytes| bytes.first()).is_none_or(|first| first & 1 == 0)
}

/// The value Task Manager writes for an entry it lets run.
#[cfg_attr(not(windows), allow(dead_code))]
const APPROVED: [u8; 12] = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/// A desktop entry's `Exec` line for `program`. The path is one quoted
/// argument: `"`, `` ` ``, `$` and `\` are escaped inside the quotes, then
/// every `\` is doubled again because the value itself is an escaped string,
/// and `%` becomes `%%` so it is not read as a field code.
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
pub(crate) fn desktop_exec(program: &Path) -> String {
    let mut quoted = String::new();
    for character in program.to_string_lossy().chars() {
        match character {
            '"' | '`' | '$' => { quoted.push_str("\\\\"); quoted.push(character); }
            '\\' => quoted.push_str("\\\\\\\\"),
            '%' => quoted.push_str("%%"),
            _ => quoted.push(character),
        }
    }
    format!("Exec=\"{quoted}\" {LOGIN_ARG}")
}

#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
pub(crate) fn desktop_entry(item: &LoginItem) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName={}\n{}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
        item.name.replace('\n', " "),
        desktop_exec(&item.program)
    )
}

/// Whether an autostart file runs `item` at login: our `Exec` line, and not
/// hidden or switched off by the desktop's own startup settings.
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
pub(crate) fn desktop_entry_enabled(text: &str, item: &LoginItem) -> bool {
    let exec = desktop_exec(&item.program);
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    lines.contains(&exec.as_str()) && !lines.contains(&"Hidden=true") && !lines.contains(&"X-GNOME-Autostart-enabled=false")
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn launch_agent(item: &LoginItem) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\">\n<dict>\n\
  <key>Label</key>\n  <string>{}</string>\n\
  <key>ProgramArguments</key>\n  <array>\n    <string>{}</string>\n    <string>{LOGIN_ARG}</string>\n  </array>\n\
  <key>RunAtLoad</key>\n  <true/>\n\
  <key>ProcessType</key>\n  <string>Interactive</string>\n\
</dict>\n</plist>\n",
        xml_escape(&item.identifier),
        xml_escape(&item.program.to_string_lossy())
    )
}

/// Writes `text` to `path` through a temporary file in the same directory.
#[cfg_attr(windows, allow(dead_code))]
fn write_file(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("{} could not be created: {error}", parent.display()))?;
    }
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, text).map_err(|error| format!("{} could not be written: {error}", temporary.display()))?;
    std::fs::rename(&temporary, path).map_err(|error| format!("{} could not be written: {error}", path.display()))
}

#[cfg_attr(windows, allow(dead_code))]
fn remove_file(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("{} could not be removed: {error}", path.display())),
    }
}

#[cfg_attr(windows, allow(dead_code))]
fn read_file(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{} could not be read: {error}", path.display())),
    }
}

#[cfg(windows)]
mod backend {
    use super::{approved, windows_command, LoginItem, APPROVED};
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegGetValueW, RegOpenKeyExW, RegSetValueExW, HKEY,
        HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_BINARY, REG_OPTION_NON_VOLATILE, REG_SZ,
        RRF_RT_REG_BINARY, RRF_RT_REG_SZ,
    };

    pub(crate) const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    pub(crate) const STARTUP_APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// An open key of the current user's hive, closed on drop.
    struct Key(HKEY);

    impl Drop for Key {
        fn drop(&mut self) {
            // SAFETY: the handle came from RegOpenKeyExW or RegCreateKeyExW.
            unsafe { RegCloseKey(self.0) };
        }
    }

    impl Key {
        /// `None` when the key does not exist.
        fn open(path: &str, access: u32) -> Result<Option<Key>, String> {
            let mut key: HKEY = std::ptr::null_mut();
            // SAFETY: the path is NUL-terminated and outlives the call.
            let status = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, wide(path).as_ptr(), 0, access, &mut key) };
            match status {
                ERROR_SUCCESS => Ok(Some(Key(key))),
                ERROR_FILE_NOT_FOUND => Ok(None),
                status => Err(format!(r"HKCU\{path} could not be opened: error {status}")),
            }
        }

        fn create(path: &str) -> Result<Key, String> {
            let mut key: HKEY = std::ptr::null_mut();
            // SAFETY: the path is NUL-terminated and outlives the call; the
            // optional pointers are null, which the API accepts.
            let status = unsafe {
                RegCreateKeyExW(HKEY_CURRENT_USER, wide(path).as_ptr(), 0, std::ptr::null(), REG_OPTION_NON_VOLATILE,
                    KEY_SET_VALUE | KEY_QUERY_VALUE, std::ptr::null(), &mut key, std::ptr::null_mut())
            };
            if status != ERROR_SUCCESS {
                return Err(format!(r"HKCU\{path} could not be opened for writing: error {status}"));
            }
            Ok(Key(key))
        }

        /// The raw bytes of a value of `kind`, `None` when it does not exist.
        fn get(&self, name: &str, kind: u32) -> Result<Option<Vec<u8>>, String> {
            let name = wide(name);
            let mut size = 0u32;
            // SAFETY: a null buffer asks for the size only.
            let status = unsafe { RegGetValueW(self.0, std::ptr::null(), name.as_ptr(), kind, std::ptr::null_mut(), std::ptr::null_mut(), &mut size) };
            if status == ERROR_FILE_NOT_FOUND { return Ok(None); }
            if status != ERROR_SUCCESS { return Err(format!("a startup value could not be read: error {status}")); }
            let mut data = vec![0u8; size as usize];
            // SAFETY: `data` holds `size` bytes, the size the call asked for.
            let status = unsafe { RegGetValueW(self.0, std::ptr::null(), name.as_ptr(), kind, std::ptr::null_mut(), data.as_mut_ptr().cast(), &mut size) };
            if status == ERROR_FILE_NOT_FOUND { return Ok(None); }
            if status != ERROR_SUCCESS { return Err(format!("a startup value could not be read: error {status}")); }
            data.truncate(size as usize);
            Ok(Some(data))
        }

        fn set(&self, name: &str, kind: u32, data: &[u8]) -> Result<(), String> {
            // SAFETY: the name is NUL-terminated and `data` holds exactly its length.
            let status = unsafe { RegSetValueExW(self.0, wide(name).as_ptr(), 0, kind, data.as_ptr(), data.len() as u32) };
            if status != ERROR_SUCCESS { return Err(format!("the startup value {name:?} could not be written: error {status}")); }
            Ok(())
        }

        fn delete(&self, name: &str) -> Result<(), String> {
            // SAFETY: the name is NUL-terminated and outlives the call.
            let status = unsafe { RegDeleteValueW(self.0, wide(name).as_ptr()) };
            match status {
                ERROR_SUCCESS | ERROR_FILE_NOT_FOUND => Ok(()),
                status => Err(format!("the startup value {name:?} could not be removed: error {status}")),
            }
        }
    }

    fn text(bytes: &[u8]) -> String {
        let units: Vec<u16> = bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        String::from_utf16_lossy(&units).trim_end_matches('\0').to_owned()
    }

    pub(crate) fn enabled_at(item: &LoginItem, run: &str, startup_approved: &str) -> Result<bool, String> {
        let Some(key) = Key::open(run, KEY_QUERY_VALUE)? else { return Ok(false) };
        let Some(command) = key.get(&item.name, RRF_RT_REG_SZ)? else { return Ok(false) };
        if text(&command) != windows_command(&item.program) { return Ok(false); }
        let state = match Key::open(startup_approved, KEY_QUERY_VALUE)? {
            Some(key) => key.get(&item.name, RRF_RT_REG_BINARY)?,
            None => None,
        };
        Ok(approved(state.as_deref()))
    }

    pub(crate) fn enable_at(item: &LoginItem, run: &str, startup_approved: &str) -> Result<(), String> {
        let command: Vec<u8> = wide(&windows_command(&item.program))
            .into_iter().flat_map(u16::to_le_bytes).collect();
        Key::create(run)?.set(&item.name, REG_SZ, &command)?;
        // An entry once turned off in Task Manager stays off until this says
        // otherwise: the switch in Settings is the user asking again.
        if let Some(key) = Key::open(startup_approved, KEY_SET_VALUE)? {
            key.set(&item.name, REG_BINARY, &APPROVED)?;
        }
        Ok(())
    }

    pub(crate) fn disable_at(item: &LoginItem, run: &str, startup_approved: &str) -> Result<(), String> {
        if let Some(key) = Key::open(run, KEY_SET_VALUE)? { key.delete(&item.name)?; }
        if let Some(key) = Key::open(startup_approved, KEY_SET_VALUE)? { key.delete(&item.name)?; }
        Ok(())
    }

    pub(super) fn enabled(item: &LoginItem) -> Result<bool, String> { enabled_at(item, RUN, STARTUP_APPROVED) }
    pub(super) fn enable(item: &LoginItem) -> Result<(), String> { enable_at(item, RUN, STARTUP_APPROVED) }
    pub(super) fn disable(item: &LoginItem) -> Result<(), String> { disable_at(item, RUN, STARTUP_APPROVED) }

    /// Deletes a scratch key tree a test created.
    #[cfg(test)]
    pub(crate) fn delete_tree(path: &str) {
        use windows_sys::Win32::System::Registry::RegDeleteTreeW;
        // SAFETY: the path is NUL-terminated and outlives the call.
        unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, wide(path).as_ptr()) };
    }

    /// Writes a raw `StartupApproved` value, as Task Manager does.
    #[cfg(test)]
    pub(crate) fn set_binary(path: &str, name: &str, data: &[u8]) {
        Key::create(path).unwrap().set(name, REG_BINARY, data).unwrap();
    }
}

#[cfg(target_os = "macos")]
mod backend {
    use super::{launch_agent, read_file, remove_file, write_file, LoginItem};
    use std::path::PathBuf;

    fn file(item: &LoginItem) -> Result<PathBuf, String> {
        let home = std::env::var_os("HOME").ok_or("HOME is not set, so the LaunchAgents folder cannot be found")?;
        Ok(PathBuf::from(home).join("Library/LaunchAgents").join(format!("{}.plist", item.identifier)))
    }

    pub(super) fn enabled(item: &LoginItem) -> Result<bool, String> {
        Ok(read_file(&file(item)?)?.is_some_and(|text| text == launch_agent(item)))
    }
    pub(super) fn enable(item: &LoginItem) -> Result<(), String> { write_file(&file(item)?, &launch_agent(item)) }
    pub(super) fn disable(item: &LoginItem) -> Result<(), String> { remove_file(&file(item)?) }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod backend {
    use super::{desktop_entry, desktop_entry_enabled, read_file, remove_file, write_file, LoginItem};
    use std::path::{Path, PathBuf};

    /// `$XDG_CONFIG_HOME/autostart`, or `~/.config/autostart`.
    fn directory() -> Result<PathBuf, String> {
        if let Some(config) = std::env::var_os("XDG_CONFIG_HOME").filter(|value| Path::new(value).is_absolute()) {
            return Ok(PathBuf::from(config).join("autostart"));
        }
        let home = std::env::var_os("HOME").ok_or("HOME is not set, so the autostart folder cannot be found")?;
        Ok(PathBuf::from(home).join(".config/autostart"))
    }

    pub(crate) fn file_in(directory: &Path, item: &LoginItem) -> PathBuf {
        directory.join(format!("{}.desktop", item.identifier))
    }

    pub(crate) fn enabled_in(directory: &Path, item: &LoginItem) -> Result<bool, String> {
        Ok(read_file(&file_in(directory, item))?.is_some_and(|text| desktop_entry_enabled(&text, item)))
    }
    pub(crate) fn enable_in(directory: &Path, item: &LoginItem) -> Result<(), String> {
        write_file(&file_in(directory, item), &desktop_entry(item))
    }
    pub(crate) fn disable_in(directory: &Path, item: &LoginItem) -> Result<(), String> {
        remove_file(&file_in(directory, item))
    }

    pub(super) fn enabled(item: &LoginItem) -> Result<bool, String> { enabled_in(&directory()?, item) }
    pub(super) fn enable(item: &LoginItem) -> Result<(), String> { enable_in(&directory()?, item) }
    pub(super) fn disable(item: &LoginItem) -> Result<(), String> { disable_in(&directory()?, item) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(program: &str) -> LoginItem {
        LoginItem { name: "Boite Test".into(), identifier: "com.boite.two.test".into(), program: PathBuf::from(program) }
    }

    #[test]
    fn a_windows_path_with_spaces_is_one_quoted_program() {
        assert_eq!(
            windows_command(Path::new(r"C:\Users\Jean Dupont\AppData\Local\Boite\boite-shell.exe")),
            r#""C:\Users\Jean Dupont\AppData\Local\Boite\boite-shell.exe" --autostart"#
        );
    }

    #[test]
    fn task_manager_turning_the_entry_off_is_read_as_off() {
        assert!(approved(None), "no StartupApproved value: Windows runs the entry");
        assert!(approved(Some(&APPROVED)));
        assert!(approved(Some(&[6, 0, 0, 0])));
        assert!(!approved(Some(&[3, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8])));
        assert!(!approved(Some(&[7, 0, 0, 0])));
    }

    #[test]
    fn a_desktop_entry_quotes_and_escapes_the_program() {
        assert_eq!(desktop_exec(Path::new("/opt/My Apps/boite")), "Exec=\"/opt/My Apps/boite\" --autostart");
        // `$` and `"` are escaped for the quoted argument, then the backslash
        // is doubled for the string value; `%` is not a field code.
        assert_eq!(desktop_exec(Path::new("/a/$b\"c/100%")), r#"Exec="/a/\\$b\\"c/100%%" --autostart"#);
        assert_eq!(desktop_exec(Path::new(r"/a\b")), r#"Exec="/a\\\\b" --autostart"#);
    }

    #[test]
    fn a_desktop_entry_counts_only_when_it_runs_this_program() {
        let ours = item("/opt/Boite/boite");
        let entry = desktop_entry(&ours);
        assert!(desktop_entry_enabled(&entry, &ours));
        assert!(!desktop_entry_enabled(&entry, &item("/elsewhere/boite")), "another install's entry is not this one's");
        assert!(!desktop_entry_enabled(&format!("{entry}Hidden=true\n"), &ours));
        assert!(!desktop_entry_enabled(&entry.replace("X-GNOME-Autostart-enabled=true", "X-GNOME-Autostart-enabled=false"), &ours));
    }

    #[test]
    fn a_launch_agent_escapes_the_program_and_runs_at_load() {
        let agent = launch_agent(&item("/Applications/A & B.app/Contents/MacOS/boite-shell"));
        assert!(agent.contains("<string>/Applications/A &amp; B.app/Contents/MacOS/boite-shell</string>"));
        assert!(agent.contains("<string>--autostart</string>"));
        assert!(agent.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(agent.contains("<string>com.boite.two.test</string>"));
    }

    /// The real XDG files, in a scratch directory: on, read back, off.
    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn an_autostart_file_is_written_read_and_removed() {
        let directory = std::env::temp_dir().join(format!("boite-autostart-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        let ours = item("/opt/My Apps/boite");
        assert!(!backend::enabled_in(&directory, &ours).unwrap());
        backend::enable_in(&directory, &ours).unwrap();
        assert!(backend::enabled_in(&directory, &ours).unwrap());
        assert!(!backend::enabled_in(&directory, &item("/other/boite")).unwrap());
        backend::disable_in(&directory, &ours).unwrap();
        assert!(!backend::file_in(&directory, &ours).exists());
        backend::disable_in(&directory, &ours).unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    /// The real registry calls, on a scratch key of the current user's hive
    /// that nothing runs at login, deleted afterwards.
    #[cfg(windows)]
    #[test]
    fn a_run_value_is_written_read_turned_off_by_task_manager_and_removed() {
        let root = format!(r"Software\BoiteTest-autostart-{}", std::process::id());
        let (run, startup) = (format!(r"{root}\Run"), format!(r"{root}\Approved"));
        backend::delete_tree(&root);
        let ours = item(r"C:\Users\Jean Dupont\Boite\boite-shell.exe");
        // No key at all yet, as on a fresh profile.
        assert!(!backend::enabled_at(&ours, &run, &startup).unwrap());
        backend::disable_at(&ours, &run, &startup).unwrap();
        backend::enable_at(&ours, &run, &startup).unwrap();
        assert!(backend::enabled_at(&ours, &run, &startup).unwrap());
        assert!(!backend::enabled_at(&item(r"C:\Other\boite-shell.exe"), &run, &startup).unwrap());
        // Task Manager turns it off; turning it on in Settings wins again.
        backend::set_binary(&startup, &ours.name, &[3, 0, 0, 0, 9, 9, 9, 9, 9, 9, 9, 9]);
        assert!(!backend::enabled_at(&ours, &run, &startup).unwrap());
        backend::enable_at(&ours, &run, &startup).unwrap();
        assert!(backend::enabled_at(&ours, &run, &startup).unwrap());
        backend::disable_at(&ours, &run, &startup).unwrap();
        assert!(!backend::enabled_at(&ours, &run, &startup).unwrap());
        backend::delete_tree(&root);
    }
}
