//! The window material (acrylic, mica or solid) the settings page picks, and
//! which of them this Windows build offers.

use tauri::{utils::config::WindowEffectsConfig, window::Effect, AppHandle, Manager, Webview};

use crate::browser::{self, MAIN_LABEL};

/// What the UI's "Window material" setting asks of the window, as the effects
/// Tauri hands to `window_vibrancy`. `None` is the answer for "solid": it clears
/// whatever the window wears. Pure, so every case is a test, and a value nobody
/// defined is refused with the value in the message rather than quietly falling
/// back on a material the user never picked.
fn effects_for(kind: &str) -> Result<Option<WindowEffectsConfig>, String> {
    let effects = match kind {
        // Tauri applies the first effect of the list and ignores the rest, so
        // the order is the choice: acrylic, and blur behind it for a Windows
        // that has no acrylic to give.
        "acrylic" => vec![Effect::Acrylic, Effect::Blur],
        "mica" => vec![Effect::Mica],
        "solid" => return Ok(None),
        other => {
            return Err(format!(
                "unknown window material {other:?}: acrylic, mica or solid"
            ))
        }
    };
    Ok(Some(WindowEffectsConfig {
        effects,
        state: None,
        radius: None,
        color: None,
    }))
}

/// The Windows build number, 0 off Windows.
pub(crate) fn windows_build() -> u32 {
    #[cfg(windows)]
    { windows_version::OsVersion::current().build }
    #[cfg(not(windows))]
    { 0 }
}

/// The materials this Windows build draws without a cost the user feels. Mica
/// exists from Windows 11 (22000). Acrylic before 22523 is the
/// `SetWindowCompositionAttribute` path that `window_vibrancy` itself warns
/// makes the window lag on every drag and resize; from 22523 DWM draws it as a
/// system backdrop, as cheap as mica. So acrylic is offered from 22523 only,
/// and Windows 10 gets solid alone. Pure, so every build is a test.
pub(crate) fn supported_materials(build: u32) -> Vec<&'static str> {
    let mut kinds = Vec::with_capacity(3);
    if build >= 22523 { kinds.push("acrylic"); }
    if build >= 22000 { kinds.push("mica"); }
    kinds.push("solid");
    kinds
}

/// The material the window wears, changed from the settings page while the app
/// runs. Async like the browser commands: a synchronous command runs on the main
/// thread, which is the thread the window work has to come back to.
#[tauri::command]
pub(crate) async fn window_material(app: AppHandle, webview: Webview, kind: String) -> Result<(), String> {
    browser::only_main(&webview)?;
    let effects = effects_for(&kind)?;
    // `set_effects` reports success for a material this Windows cannot draw,
    // and the page would then turn transparent over nothing: refuse it here.
    let build = windows_build();
    let supported = supported_materials(build);
    if !supported.contains(&kind.as_str()) {
        return Err(format!(
            "the window material {kind:?} is not offered on Windows build {build}: {}",
            supported.join(", ")
        ));
    }
    let window = app
        .get_webview_window(MAIN_LABEL)
        .ok_or_else(|| format!("the {MAIN_LABEL:?} window is gone: no material was applied"))?;
    window
        .set_effects(effects)
        .map_err(|error| format!("the window material {kind:?} was refused: {error}"))
}

/// The materials the setting may offer, empty off Windows. The setting hides
/// itself when solid is all there is: a control that changes nothing is worse
/// than no control.
#[tauri::command]
pub(crate) fn window_material_supported(webview: Webview) -> Result<Vec<&'static str>, String> {
    browser::only_main(&webview)?;
    Ok(if cfg!(windows) { supported_materials(windows_build()) } else { Vec::new() })
}

#[cfg(test)]
mod tests {
    use super::{effects_for, supported_materials};
    use tauri::window::Effect;

    #[test]
    fn acrylic_asks_for_acrylic_first_and_blur_behind_it() {
        let config = effects_for("acrylic")
            .expect("acrylic is a material")
            .expect("acrylic paints something");
        assert_eq!(config.effects, vec![Effect::Acrylic, Effect::Blur]);
    }

    #[test]
    fn mica_asks_for_mica_alone() {
        let config = effects_for("mica")
            .expect("mica is a material")
            .expect("mica paints something");
        assert_eq!(config.effects, vec![Effect::Mica]);
    }

    #[test]
    fn a_material_is_offered_only_where_windows_draws_it_without_lag() {
        // Windows 10 22H2: acrylic there lags on every drag, and mica does not exist.
        assert_eq!(supported_materials(19045), ["solid"]);
        // Windows 11 21H2: mica, and still the lagging acrylic.
        assert_eq!(supported_materials(22000), ["mica", "solid"]);
        assert_eq!(supported_materials(22522), ["mica", "solid"]);
        // From 22523 DWM draws acrylic as a system backdrop.
        assert_eq!(supported_materials(22523), ["acrylic", "mica", "solid"]);
        assert_eq!(supported_materials(26100), ["acrylic", "mica", "solid"]);
    }

    #[test]
    fn solid_clears_the_material_rather_than_painting_one() {
        assert!(effects_for("solid").expect("solid is a material").is_none());
    }

    #[test]
    fn a_material_nobody_defined_is_refused_by_name() {
        let error = effects_for("frosted").expect_err("frosted is not a material");
        assert!(error.contains("frosted"), "the refusal never named it: {error}");
    }
}
