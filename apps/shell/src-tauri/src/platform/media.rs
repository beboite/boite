//! What the system media session is playing, and its play/pause, next and
//! previous buttons: Windows' GlobalSystemMediaTransportControls. A Spotify
//! session wins over whichever the system calls current. Elsewhere nothing
//! plays, as far as the shell can tell.

use serde::Serialize;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub(crate) struct MediaState {
    pub title: String,
    pub artist: String,
    /// The session's app id (`Spotify.exe`, `MSEdge`...), for the page to name.
    pub app: String,
    pub playing: bool,
}

/// The three buttons of the media session.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum MediaAction { Toggle, Next, Previous }

impl MediaAction {
    pub(crate) fn parse(action: &str) -> Result<Self, String> {
        match action {
            "toggle" => Ok(Self::Toggle),
            "next" => Ok(Self::Next),
            "previous" => Ok(Self::Previous),
            _ => Err(format!("media action must be toggle, next or previous, not {action:?}")),
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::{MediaAction, MediaState};
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };

    fn session() -> windows::core::Result<Option<Session>> {
        let manager = Manager::RequestAsync()?.get()?;
        for session in &manager.GetSessions()? {
            if session.SourceAppUserModelId()?.to_string().to_lowercase().contains("spotify") {
                return Ok(Some(session));
            }
        }
        Ok(manager.GetCurrentSession().ok())
    }

    pub(super) fn state() -> Result<Option<MediaState>, String> {
        let read = || -> windows::core::Result<Option<MediaState>> {
            let Some(session) = session()? else { return Ok(None) };
            let properties = session.TryGetMediaPropertiesAsync()?.get()?;
            Ok(Some(MediaState {
                title: properties.Title()?.to_string(),
                artist: properties.Artist()?.to_string(),
                app: session.SourceAppUserModelId()?.to_string(),
                playing: session.GetPlaybackInfo()?.PlaybackStatus()? == Status::Playing,
            }))
        };
        read().map_err(|error| error.to_string())
    }

    pub(super) fn control(action: MediaAction) -> Result<(), String> {
        let press = || -> windows::core::Result<()> {
            let Some(session) = session()? else { return Ok(()) };
            match action {
                MediaAction::Toggle => session.TryTogglePlayPauseAsync()?.get()?,
                MediaAction::Next => session.TrySkipNextAsync()?.get()?,
                MediaAction::Previous => session.TrySkipPreviousAsync()?.get()?,
            };
            Ok(())
        };
        press().map_err(|error| error.to_string())
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{MediaAction, MediaState};
    pub(super) fn state() -> Result<Option<MediaState>, String> { Ok(None) }
    pub(super) fn control(_: MediaAction) -> Result<(), String> { Ok(()) }
}

/// Blocks on the system's media service: call it off the UI thread.
pub(crate) fn media_state() -> Result<Option<MediaState>, String> { imp::state() }

/// Blocks like [`media_state`]. No session is not an error: nothing to press.
pub(crate) fn media_control(action: MediaAction) -> Result<(), String> { imp::control(action) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_three_buttons_are_accepted() {
        assert_eq!(MediaAction::parse("toggle"), Ok(MediaAction::Toggle));
        assert_eq!(MediaAction::parse("next"), Ok(MediaAction::Next));
        assert_eq!(MediaAction::parse("previous"), Ok(MediaAction::Previous));
        assert!(MediaAction::parse("stop").unwrap_err().contains("\"stop\""));
    }
}
