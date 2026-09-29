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
    let home = std::env::var("HOME")
        .map_err(|_| "HOME is not set, so the data directory cannot be found".to_string())?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("share")
        .join(channel.data_dir_name()))
}
