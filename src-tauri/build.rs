use std::fs;
use std::path::Path;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

fn main() {
    tauri_build::build();

    let pub_key_path = Path::new("src/license_key.pub");
    println!("cargo:rerun-if-changed={}", pub_key_path.display());
    println!("cargo:rerun-if-changed=src/revoked_keys.txt");

    let content = fs::read_to_string(pub_key_path)
        .unwrap_or_else(|e| panic!("src-tauri/src/license_key.pub does not exist: {e}"));

    // One trusted public key per line; `#` starts a comment.
    let keys: Vec<&str> = content
        .lines()
        .map(|line| line.split('#').next().unwrap_or("").trim())
        .filter(|entry| !entry.is_empty())
        .collect();
    assert!(
        !keys.is_empty(),
        "src-tauri/src/license_key.pub lists no public keys. Run `npm run keygen -- init` or restore it from git."
    );

    for key in keys {
        let bytes = URL_SAFE_NO_PAD.decode(key).unwrap_or_else(|e| {
            panic!("src-tauri/src/license_key.pub: {key:?} is not valid base64url text: {e}")
        });
        assert_eq!(
            bytes.len(),
            32,
            "src-tauri/src/license_key.pub: {key:?} decodes to {} bytes, expected 32 for Ed25519",
            bytes.len()
        );
    }
}
