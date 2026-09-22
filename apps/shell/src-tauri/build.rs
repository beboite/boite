fn main() {
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Let the cfg(test) link in lib.rs find the resource Tauri generated.
        println!("cargo:rustc-link-search=native={}", std::env::var("OUT_DIR").unwrap());
    }
}
