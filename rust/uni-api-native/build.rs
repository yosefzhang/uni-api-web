use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let pkg = manifest.join("../../webui/package.json");
    let version = std::fs::read_to_string(&pkg)
        .ok()
        .and_then(|content| {
            let json = content.as_str();
            let idx = json.find("\"version\"")?;
            let rest = &json[idx..];
            let start = rest.find('"')?;
            let rest = &rest[start + 1..];
            let end = rest.find('"')?;
            Some(rest[..end].to_string())
        })
        .unwrap_or_else(|| "0.0.0".to_string());
    println!("cargo:rerun-if-changed=../../webui/package.json");
    println!("cargo:rustc-env=UNI_API_WEB_VERSION={version}");
}
