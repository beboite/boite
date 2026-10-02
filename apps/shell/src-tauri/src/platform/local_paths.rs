use std::path::Path;

fn refused(path: &Path) -> String {
    format!("path {}: expected a local file or folder, not a network or device path", path.display())
}

pub(crate) fn require_local_path(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    return check_windows_path(path, |drive| {
        let root = [u16::from(drive), b':' as u16, b'\\' as u16, 0];
        // SAFETY: the NUL-terminated drive root outlives this synchronous call.
        unsafe { windows_sys::Win32::Storage::FileSystem::GetDriveTypeW(root.as_ptr()) == 4 } // DRIVE_REMOTE
    });
    #[cfg(not(windows))]
    reject_network_spelling(path)
}

fn reject_network_spelling(path: &Path) -> Result<(), String> {
    let text = path.as_os_str().to_string_lossy();
    let mut chars = text.chars();
    if matches!(chars.next(), Some('/' | '\\')) && matches!(chars.next(), Some('/' | '\\')) {
        return Err(refused(path));
    }
    Ok(())
}

#[cfg(windows)]
fn check_windows_path(path: &Path, remote_drive: impl FnOnce(u8) -> bool) -> Result<(), String> {
    use std::path::{Component, Prefix};
    match path.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            // canonicalize produces VerbatimDisk paths for ordinary local files.
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) if path.is_absolute() => {
                if remote_drive(drive) { Err(refused(path)) } else { Ok(()) }
            }
            _ => Err(refused(path)),
        },
        _ => reject_network_spelling(path),
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn rejects_unc_device_and_mapped_drives_including_resolved_paths() {
        for path in [r"\\server\share\file", "//server/share/file", r"\/server\share\file", r"/\server\share\file",
            r"\\?\UNC\server\share\file", r"\\.\pipe\file", r"\\?\Volume{abc}\file", r"C:relative.txt"] {
            assert!(check_windows_path(Path::new(path), |_| false).is_err(), "{path}");
        }
        for path in [r"Z:\share\file", r"\\?\Z:\share\file"] {
            assert!(check_windows_path(Path::new(path), |drive| drive == b'Z').is_err(), "{path}");
        }
        for path in [r"C:\local\file", r"\\?\C:\local\file", "notes.txt"] {
            assert!(check_windows_path(Path::new(path), |_| false).is_ok(), "{path}");
        }
    }
}
