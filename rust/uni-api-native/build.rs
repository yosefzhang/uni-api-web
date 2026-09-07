use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let pkg = manifest.join("../../webui/package.json");
    let version = std::fs::read_to_string(&pkg)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|v| v.get("version").and_then(|v| v.as_str()).map(String::from))
        .unwrap_or_else(|| "0.0.0".to_string());
    println!("cargo:rerun-if-changed=../../webui/package.json");
    println!("cargo:rustc-env=UNI_API_WEB_VERSION={version}");
}
