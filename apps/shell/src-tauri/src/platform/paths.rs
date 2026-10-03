use std::path::PathBuf;
use crate::channel::Channel;

#[cfg(windows)]
pub(crate) fn default_data_dir(channel: Channel) -> Result<PathBuf, String> {
    let local = std::env::var("LOCALAPPDATA")
        .map_err(|_| "LOCALAPPDATA is not set, so the data directory cannot be found".to_string())?;
    Ok(PathBuf::from(local).join(channel.data_dir_name()))
}

#[cfg(target_os = "macos")]
pub(crate) fn default_data_dir(channel: Channel) -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .map_err(|_| "HOME is not set, so the data directory cannot be found".to_string())?;
    Ok(PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join(channel.data_dir_name()))
}

#[cfg(all(not(windows), not(target_os = "macos")))]
pub(crate) fn default_data_dir(channel: Channel) -> Result<PathBuf, String> {
    let legacy = std::env::var_os("HOME").map(|home| PathBuf::from(home)
        .join(".local").join("share").join(channel.data_dir_name()));
    if let Some(data_home) = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|path| path.is_absolute()) {
        let directory = data_home.join(channel.data_dir_name());
        // Keep pre-XDG conversations visible until the new location has a journal.
        if let Some(previous) = legacy.as_ref().filter(|path| path.join("journal.db").exists() && !directory.join("journal.db").exists()) {
            return Ok(previous.clone());
        }
        return Ok(directory);
    }
    legacy.ok_or_else(|| "HOME is not set, so the data directory cannot be found".to_string())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn the_shell_and_core_use_the_same_xdg_data_directory() {
        let _guard = crate::process_test_guard();
        let previous = std::env::var_os("XDG_DATA_HOME");
        let previous_home = std::env::var_os("HOME");
        let root = std::env::temp_dir().join(format!("boite-data-paths-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let home = root.join("home");
        let data_home = root.join("Boite's données");
        std::env::set_var("HOME", &home);
        std::env::set_var("XDG_DATA_HOME", &data_home);
        let stable = default_data_dir(Channel::Stable).unwrap();
        let dev = default_data_dir(Channel::Dev).unwrap();
        std::env::set_var("XDG_DATA_HOME", "relative/data");
        let relative = default_data_dir(Channel::Stable).unwrap();
        std::env::set_var("XDG_DATA_HOME", "");
        let empty = default_data_dir(Channel::Stable).unwrap();
        let fallback = home.join(".local/share/boite2");
        std::fs::create_dir_all(&fallback).unwrap();
        std::fs::write(fallback.join("journal.db"), []).unwrap();
        std::env::set_var("XDG_DATA_HOME", &data_home);
        let kept = default_data_dir(Channel::Stable).unwrap();
        std::fs::create_dir_all(data_home.join("boite2")).unwrap();
        std::fs::write(data_home.join("boite2/journal.db"), []).unwrap();
        let selected = default_data_dir(Channel::Stable).unwrap();
        match previous {
            Some(value) => std::env::set_var("XDG_DATA_HOME", value),
            None => std::env::remove_var("XDG_DATA_HOME"),
        }
        match previous_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(stable, data_home.join("boite2"));
        assert_eq!(dev, data_home.join("boite2-dev"));
        assert_eq!(relative, fallback);
        assert_eq!(empty, fallback);
        assert_eq!(kept, fallback);
        assert_eq!(selected, data_home.join("boite2"));
    }
}
