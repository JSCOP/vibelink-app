use std::{env, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let app_root = manifest
        .join("../../..")
        .canonicalize()
        .expect("canonical VibeLink app root");
    let app_src = app_root.join("src-tauri/src");
    println!("cargo:rustc-env=HARNESS_APP_ROOT={}", app_root.display());
    println!("cargo:rustc-env=HARNESS_APP_SRC={}", app_src.display());
    println!("cargo:rerun-if-changed={}", app_root.join("contracts/remote-v2.json").display());
    println!("cargo:rerun-if-changed={}", app_src.join("remote").display());
}
