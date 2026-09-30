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

    let trimmed = content.trim();
    assert!(
        !trimmed.is_empty(),
        "src-tauri/src/license_key.pub is empty. Run `npm run keygen -- init` or restore a valid key."
    );

    let bytes = URL_SAFE_NO_PAD
        .decode(trimmed)
        .unwrap_or_else(|e| panic!("src-tauri/src/license_key.pub is not valid base64url text: {e}"));

    assert_eq!(
        bytes.len(),
        32,
        "src-tauri/src/license_key.pub decoded length is {} bytes, expected 32 bytes for Ed25519",
        bytes.len()
    );
}
