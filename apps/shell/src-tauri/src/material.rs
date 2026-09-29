//! The window material (acrylic, mica or solid) the settings page picks, and
//! which of them this Windows build offers.
//!
//! The shell sets the material as one DWM attribute and never goes through
//! Tauri's `set_effects`. Tauri clears a material (`set_effects(None)`, our
//! solid) with `window_vibrancy`'s `clear_blur`, `clear_acrylic` and
//! `clear_mica`, and `clear_blur` calls `SetWindowCompositionAttribute` with
//! `ACCENT_DISABLED` on every build from 17763. That call is the one thing the
//! path that broke did and the path that worked did not: a window that opened
//! on acrylic and moved to mica kept its backdrop, while a material picked
//! after solid was stored by DWM (it reads back) and drawn as nothing, the page
//! see-through over the desktop. Here solid is the backdrop attribute set to
//! none, one write like every other material, and no accent policy is ever set.

use tauri::{AppHandle, Manager, Webview};

use crate::browser::{self, MAIN_LABEL};

/// `DWMWA_SYSTEMBACKDROP_TYPE`, documented from build 22621 and honoured from
/// 22523, and the three values the setting uses of it.
const SYSTEMBACKDROP_TYPE: u32 = 38;
const DWMSBT_NONE: u32 = 1;
const DWMSBT_MAINWINDOW: u32 = 2;
const DWMSBT_TRANSIENTWINDOW: u32 = 3;
/// The undocumented attribute Windows 11 builds before 22523 draw mica from:
/// 1 on, 0 off.
const MICA_EFFECT: u32 = 1029;

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

/// The DWM attribute and value that draw `kind` on `build`, or `None` where
/// there is nothing to set: solid on a Windows that offers nothing else, whose
/// window is built opaque. A material nobody defined, or one this build does
/// not offer, is refused by name: `DwmSetWindowAttribute` would take the value
/// and draw nothing, and the page would turn see-through over the desktop.
/// Every material, solid included, is one write to the same attribute, so
/// any order of changes ends on exactly what was asked last.
pub(crate) fn backdrop_for(kind: &str, build: u32) -> Result<Option<(u32, u32)>, String> {
    if !matches!(kind, "acrylic" | "mica" | "solid") {
        return Err(format!("unknown window material {kind:?}: acrylic, mica or solid"));
    }
    let supported = supported_materials(build);
    if !supported.contains(&kind) {
        return Err(format!(
            "the window material {kind:?} is not offered on Windows build {build}: {}",
            supported.join(", ")
        ));
    }
    Ok(if build >= 22523 {
        let value = match kind {
            "acrylic" => DWMSBT_TRANSIENTWINDOW,
            "mica" => DWMSBT_MAINWINDOW,
            _ => DWMSBT_NONE,
        };
        Some((SYSTEMBACKDROP_TYPE, value))
    } else if build >= 22000 {
        Some((MICA_EFFECT, u32::from(kind == "mica")))
    } else {
        None
    })
}

/// Puts `kind` on the window and checks DWM kept it. The page only turns
/// see-through once this succeeds (`lib/glass.ts`), so a value DWM did not
/// hold leaves an opaque page rather than a transparent one.
#[cfg(windows)]
pub(crate) fn apply_material(hwnd: windows_sys::Win32::Foundation::HWND, kind: &str, build: u32) -> Result<(), String> {
    use crate::platform::dwm;
    let Some((attribute, value)) = backdrop_for(kind, build)? else { return Ok(()) };
    dwm::set_attribute(hwnd, attribute, value)
        .map_err(|error| format!("the window material {kind:?} was refused: {error}"))?;
    // The mica attribute of the older builds is write-only.
    if attribute == SYSTEMBACKDROP_TYPE {
        let held = dwm::attribute(hwnd, attribute)?;
        if held != value {
            return Err(format!("the window material {kind:?} did not hold: DWM reads backdrop {held}, not {value}"));
        }
    }
    Ok(())
}

/// The material the window wears, changed from the settings page while the app
/// runs. Async like the browser commands: a synchronous command runs on the main
/// thread, which is the thread the window work has to come back to.
#[tauri::command]
pub(crate) async fn window_material(app: AppHandle, webview: Webview, kind: String) -> Result<(), String> {
    browser::only_main(&webview)?;
    let build = windows_build();
    backdrop_for(&kind, build)?;
    let window = app
        .get_webview_window(MAIN_LABEL)
        .ok_or_else(|| format!("the {MAIN_LABEL:?} window is gone: no material was applied"))?;
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|error| format!("the {MAIN_LABEL:?} window has no handle: {error}"))?;
        apply_material(hwnd.0, &kind, build)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(())
    }
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
    use super::{backdrop_for, supported_materials};

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
    fn every_material_is_one_value_of_the_system_backdrop_solid_included() {
        assert_eq!(backdrop_for("acrylic", 26200), Ok(Some((38, 3))));
        assert_eq!(backdrop_for("mica", 26200), Ok(Some((38, 2))));
        assert_eq!(backdrop_for("solid", 26200), Ok(Some((38, 1))));
        assert_eq!(backdrop_for("acrylic", 22523), Ok(Some((38, 3))));
    }

    #[test]
    fn early_windows_11_switches_its_own_mica_attribute_on_and_off() {
        assert_eq!(backdrop_for("mica", 22000), Ok(Some((1029, 1))));
        assert_eq!(backdrop_for("solid", 22522), Ok(Some((1029, 0))));
    }

    #[test]
    fn windows_10_has_nothing_to_set_for_solid_and_refuses_the_rest() {
        assert_eq!(backdrop_for("solid", 19045), Ok(None));
        for kind in ["acrylic", "mica"] {
            let error = backdrop_for(kind, 19045).expect_err("Windows 10 offers solid alone");
            assert!(error.contains(kind) && error.contains("19045"), "the refusal never named it: {error}");
        }
        assert!(backdrop_for("acrylic", 22522).is_err(), "acrylic lags before 22523");
    }

    #[test]
    fn a_material_nobody_defined_is_refused_by_name() {
        let error = backdrop_for("frosted", 26200).expect_err("frosted is not a material");
        assert!(error.contains("frosted"), "the refusal never named it: {error}");
    }

    /// Every change between the three materials, both ways, from a window that
    /// has never worn one, on a real window that is never shown. DWM has to
    /// hold exactly the last value each time: the Tauri path this replaces left
    /// an accent policy behind at the first solid, which no read shows.
    #[cfg(windows)]
    #[test]
    fn every_change_of_material_in_any_order_ends_on_the_one_asked_last() {
        use super::apply_material;
        use crate::platform::dwm::{attribute, HiddenWindow};
        let build = super::windows_build();
        if build < 22523 {
            eprintln!("skipped: build {build} has no system backdrop to switch");
            return;
        }
        let window = HiddenWindow::new();
        let expected = |kind: &str| backdrop_for(kind, build).unwrap().unwrap().1;
        let kinds = ["acrylic", "mica", "solid"];
        let mut sequence = vec!["solid", "mica"];
        for from in kinds {
            for to in kinds {
                sequence.extend([from, to]);
            }
        }
        sequence.extend(["solid", "acrylic", "solid", "mica", "mica", "solid", "solid", "acrylic"]);
        for kind in sequence {
            apply_material(window.0, kind, build).unwrap_or_else(|error| panic!("{kind}: {error}"));
            assert_eq!(attribute(window.0, 38), Ok(expected(kind)), "after {kind}");
        }
    }
}
