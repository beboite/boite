// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Mobile targets ship their own allocator and do not build this crate as a
// binary anyway.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    boite_lib::run()
}
