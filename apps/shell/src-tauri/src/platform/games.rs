//! The app in front, for the desktop companion's gaming headset: the name of
//! its executable and whether it is a game. The executable's path is read
//! only to classify it here; neither the path nor a window title leaves this
//! module. Other systems than Windows report no app.

use serde::Serialize;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub(crate) struct FrontApp {
    /// The executable's file name, `Overwatch.exe`.
    pub exe: String,
    pub game: bool,
}

/// Games known by their executable, wherever they are installed.
const KNOWN_GAMES: &[&str] = &[
    "overwatch.exe",
    "valorant.exe",
    "valorant-win64-shipping.exe",
    "league of legends.exe",
    "cs2.exe",
    "csgo.exe",
    "dota2.exe",
    "r5apex.exe",
    "r5apex_dx12.exe",
    "fortniteclient-win64-shipping.exe",
    "rocketleague.exe",
    "gta5.exe",
    "gta5_enhanced.exe",
    "eldenring.exe",
    "cyberpunk2077.exe",
    "destiny2.exe",
    "rainbowsix.exe",
    "rainbowsix_vulkan.exe",
    "wow.exe",
    "hearthstone.exe",
    "diablo iv.exe",
    "cod.exe",
    "minecraft.windows.exe",
    "robloxplayerbeta.exe",
    "marvel-win64-shipping.exe",
];

/// Launchers, stores and helpers that sit in the stores' folders without being games.
const NOT_GAMES: &[&str] = &[
    "steam.exe",
    "steamwebhelper.exe",
    "steamservice.exe",
    "epicgameslauncher.exe",
    "epicwebhelper.exe",
    "battle.net.exe",
    "battle.net launcher.exe",
    "agent.exe",
    "riotclientservices.exe",
    "riotclientux.exe",
    "riotclientuxrender.exe",
    "galaxyclient.exe",
    "unitycrashhandler64.exe",
    "crashreportclient.exe",
    "wallpaper32.exe",
    "wallpaper64.exe",
];

/// Where the stores install their games, as lowercase pieces of a Windows path.
const GAME_FOLDERS: &[&str] = &[r"\steamapps\common\", r"\epic games\", r"\battle.net\", r"\riot games\", r"\xboxgames\", r"\gog galaxy\games\"];

/// Folders inside those that hold a store's own programs.
const STORE_FOLDERS: &[&str] = &[r"\epic games\launcher\", r"\riot games\riot client\", r"\steamapps\common\steamworks shared\", r"\steamapps\common\steam controller configs\"];

/// The file name at the end of a path, whichever slash it uses.
fn file_name(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

/// Whether the executable at `path` is a game: a known name, or a program
/// under a game store's folder (Steam's `steamapps\common`, Epic Games,
/// Battle.net, Riot, the Xbox app, GOG), launchers and helpers excepted.
pub(crate) fn is_game(path: &str) -> bool {
    let lower = path.replace('/', "\\").to_lowercase();
    let name = file_name(&lower);
    if NOT_GAMES.contains(&name) { return false; }
    if KNOWN_GAMES.contains(&name) { return true; }
    GAME_FOLDERS.iter().any(|folder| lower.contains(folder)) && !STORE_FOLDERS.iter().any(|folder| lower.contains(folder))
}

/// What the page is told about the executable at `path`.
pub(crate) fn classify(path: &str) -> FrontApp {
    FrontApp { exe: file_name(path).to_owned(), game: is_game(path) }
}

/// The app that owns the window in front, or `None` when it cannot be read
/// or is this shell (the companion or Boite itself, which say nothing new).
#[cfg(windows)]
pub(crate) fn front_app() -> Option<FrontApp> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    // SAFETY: no pointer kept; a null window (the lock screen) is handled.
    let front = unsafe { GetForegroundWindow() };
    if front.is_null() { return None; }
    let mut pid = 0u32;
    // SAFETY: `pid` outlives the call.
    unsafe { GetWindowThreadProcessId(front, &mut pid) };
    // SAFETY: plain value.
    if pid == 0 || pid == unsafe { GetCurrentProcessId() } { return None; }
    // SAFETY: the handle is closed below on every path.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() { return None; }
    let mut buffer = [0u16; 1024];
    let mut length = buffer.len() as u32;
    // SAFETY: the buffer and its length are this array's; the call writes the length it used.
    let read = unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut length) } != 0;
    // SAFETY: the handle opened above.
    unsafe { CloseHandle(process) };
    read.then(|| classify(&String::from_utf16_lossy(&buffer[..(length as usize).min(buffer.len())])))
}

#[cfg(not(windows))]
pub(crate) fn front_app() -> Option<FrontApp> { None }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_known_game_counts_wherever_it_is_installed() {
        assert!(is_game(r"C:\Program Files (x86)\Overwatch\_retail_\Overwatch.exe"));
        assert!(is_game(r"D:\Jeux\VALORANT\live\ShooterGame\Binaries\Win64\VALORANT-Win64-Shipping.exe"));
        assert!(is_game("cs2.exe"), "a bare name");
    }

    #[test]
    fn a_program_under_a_store_folder_counts() {
        assert!(is_game(r"D:\SteamLibrary\steamapps\common\Hades II\Hades2.exe"));
        assert!(is_game(r"C:\Program Files\Epic Games\Satisfactory\FactoryGame.exe"));
        assert!(is_game(r"C:\Program Files (x86)\Battle.net\Games\StarCraft II\SC2_x64.exe"));
        assert!(is_game(r"C:\Riot Games\League of Legends\Game\League of Legends.exe"));
        assert!(is_game(r"C:\XboxGames\Starfield\Content\Starfield.exe"));
        assert!(is_game("C:/Program Files (x86)/Steam/steamapps/common/Celeste/Celeste.exe"), "forward slashes");
    }

    #[test]
    fn launchers_helpers_and_other_apps_do_not() {
        assert!(!is_game(r"C:\Program Files (x86)\Steam\steam.exe"));
        assert!(!is_game(r"C:\Program Files (x86)\Steam\bin\cef\cef.win7x64\steamwebhelper.exe"));
        assert!(!is_game(r"C:\Program Files (x86)\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe"));
        assert!(!is_game(r"C:\Program Files (x86)\Battle.net\Battle.net.exe"));
        assert!(!is_game(r"C:\Riot Games\Riot Client\RiotClientServices.exe"));
        assert!(!is_game(r"D:\SteamLibrary\steamapps\common\wallpaper_engine\wallpaper64.exe"));
        assert!(!is_game(r"C:\Program Files\Mozilla Firefox\firefox.exe"));
        assert!(!is_game(r"C:\Windows\explorer.exe"));
        assert!(!is_game(r"C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe"));
    }

    #[test]
    fn only_the_file_name_is_told() {
        let app = classify(r"D:\SteamLibrary\steamapps\common\Hades II\Hades2.exe");
        assert_eq!(app, FrontApp { exe: "Hades2.exe".into(), game: true });
        assert_eq!(classify(r"C:\Windows\explorer.exe"), FrontApp { exe: "explorer.exe".into(), game: false });
    }
}
