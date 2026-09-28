#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    let executable = std::env::current_exe().unwrap();
    std::fs::write(executable.with_extension("opened"), b"opened original file").unwrap();
}
