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

    // 产品版本（uni-api 自身版本，与上游 tag 对齐）单独放在仓库根 VERSION 里，
    // 不走 Cargo.toml 的 crate 版本 —— 上游已把 crate 版本重置为 0.1.x，
    // 若改 Cargo.toml 每次上游 bump 都会冲突。
    let version_file = manifest.join("../../VERSION");
    let api_version = std::fs::read_to_string(&version_file)
        .map(|content| content.trim().to_string())
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    println!("cargo:rerun-if-changed=../../VERSION");
    println!("cargo:rustc-env=UNI_API_VERSION={api_version}");
}
